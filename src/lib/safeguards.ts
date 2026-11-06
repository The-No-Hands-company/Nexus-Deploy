/**
 * Safeguards: what keeps one member, or one runaway build, from taking the node
 * down. They are not plans or tiers. The same defaults apply to everyone, an
 * operator changes them for the whole node through CAP_* environment variables,
 * and the dashboard shows them so nobody is surprised.
 *
 * Everything here is a pure function of its inputs so it can be tested without
 * Docker, a disk or a clock.
 */
import fs from "node:fs";

export type Limits = {
  memoryMb: number;
  cpus: number;
  pids: number;
  maxProjects: number;
  maxConcurrentBuilds: number;
  maxBuildsPerHour: number;
  buildTimeoutMs: number;
  pullTimeoutMs: number;
  /** Builds are refused when a measured volume has less than this free. */
  minHostFreePercent: number;
  /** Builds are refused when the sandbox storage is fuller than this. */
  maxSandboxUsedPercent: number;
};

export const DEFAULT_LIMITS: Limits = {
  memoryMb: 512,
  cpus: 0.5,
  pids: 256,
  maxProjects: 5,
  maxConcurrentBuilds: 1,
  maxBuildsPerHour: 6,
  buildTimeoutMs: 10 * 60_000,
  pullTimeoutMs: 10 * 60_000,
  // Matches the webmaster check that already watches this node: warn at 15%.
  minHostFreePercent: 15,
  maxSandboxUsedPercent: 85,
};

function envNumber(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number (got "${raw}")`);
  }
  return value;
}

export function limitsFromEnv(env: Record<string, string | undefined>): Limits {
  return {
    memoryMb: envNumber(env, "CAP_MEMORY_MB", DEFAULT_LIMITS.memoryMb),
    cpus: envNumber(env, "CAP_CPUS", DEFAULT_LIMITS.cpus),
    pids: envNumber(env, "CAP_PIDS", DEFAULT_LIMITS.pids),
    maxProjects: envNumber(env, "CAP_MAX_PROJECTS", DEFAULT_LIMITS.maxProjects),
    maxConcurrentBuilds: envNumber(
      env,
      "CAP_MAX_CONCURRENT_BUILDS",
      DEFAULT_LIMITS.maxConcurrentBuilds,
    ),
    maxBuildsPerHour: envNumber(env, "CAP_MAX_BUILDS_PER_HOUR", DEFAULT_LIMITS.maxBuildsPerHour),
    buildTimeoutMs: envNumber(env, "CAP_BUILD_TIMEOUT_MS", DEFAULT_LIMITS.buildTimeoutMs),
    pullTimeoutMs: envNumber(env, "CAP_PULL_TIMEOUT_MS", DEFAULT_LIMITS.pullTimeoutMs),
    minHostFreePercent: envNumber(
      env,
      "CAP_MIN_HOST_FREE_PERCENT",
      DEFAULT_LIMITS.minHostFreePercent,
    ),
    maxSandboxUsedPercent: envNumber(
      env,
      "CAP_MAX_SANDBOX_USED_PERCENT",
      DEFAULT_LIMITS.maxSandboxUsedPercent,
    ),
  };
}

/** "512m" / "1g" / "512" (megabytes) → megabytes, or null if unparseable. */
export function parseMemoryMb(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([mg]?)$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  return (match[2] ?? "").toLowerCase() === "g" ? amount * 1024 : amount;
}

export type ContainerLimits = { memory: string; cpus: string; pids: number };

/** A project may ask for less than the node's cap, never more. */
export function containerLimits(
  project: { memoryLimit?: string | undefined; cpus?: string | undefined },
  limits: Limits,
): ContainerLimits {
  const askedMb = project.memoryLimit ? parseMemoryMb(project.memoryLimit) : null;
  const mb = askedMb !== null && askedMb > 0 ? Math.min(askedMb, limits.memoryMb) : limits.memoryMb;
  const askedCpus = project.cpus ? Number(project.cpus) : Number.NaN;
  const cpus =
    Number.isFinite(askedCpus) && askedCpus > 0 ? Math.min(askedCpus, limits.cpus) : limits.cpus;
  return { memory: `${Math.floor(mb)}m`, cpus: String(cpus), pids: limits.pids };
}

export type Verdict =
  | { ok: true }
  | { ok: false; code: "quota" | "busy" | "rate" | "disk"; message: string };

export function checkProjectQuota(ownedProjects: number, limits: Limits): Verdict {
  if (ownedProjects >= limits.maxProjects) {
    return {
      ok: false,
      code: "quota",
      message: `You can have up to ${limits.maxProjects} projects on this node. Delete one to make room.`,
    };
  }
  return { ok: true };
}

export type BuildContextInputs = {
  activeBuildsForMember: number;
  buildsLastHourForMember: number;
  /** Lowest free percentage over the measured host volumes; null = not measured. */
  hostFreePercent: number | null;
  /** How full the sandbox storage is; null = not measured. */
  sandboxUsedPercent: number | null;
};

/** Disk is checked first: a full disk takes production down, a busy member does not. */
export function checkBuildAllowed(input: BuildContextInputs, limits: Limits): Verdict {
  if (input.hostFreePercent !== null && input.hostFreePercent < limits.minHostFreePercent) {
    return {
      ok: false,
      code: "disk",
      message: "This node is low on disk space, so new builds are paused. Try again later.",
    };
  }
  if (
    input.sandboxUsedPercent !== null &&
    input.sandboxUsedPercent > limits.maxSandboxUsedPercent
  ) {
    return {
      ok: false,
      code: "disk",
      message: "The build storage on this node is nearly full, so new builds are paused.",
    };
  }
  if (input.activeBuildsForMember >= limits.maxConcurrentBuilds) {
    return {
      ok: false,
      code: "busy",
      message: "One of your builds is still running. Wait for it to finish.",
    };
  }
  if (input.buildsLastHourForMember >= limits.maxBuildsPerHour) {
    return {
      ok: false,
      code: "rate",
      message: `You have reached ${limits.maxBuildsPerHour} builds in the last hour. Try again later.`,
    };
  }
  return { ok: true };
}

const HOUR_MS = 60 * 60_000;

/** Builds a member started in the last hour. Rollbacks reuse an image and are free. */
export function countRecentBuilds(
  deployments: ReadonlyArray<{ projectId: string; triggeredBy: string; createdAt: number }>,
  memberProjectIds: ReadonlySet<string>,
  now: number,
): number {
  return deployments.filter(
    (d) =>
      memberProjectIds.has(d.projectId) &&
      d.triggeredBy !== "rollback" &&
      now - d.createdAt < HOUR_MS,
  ).length;
}

type StatFs = (path: string) => { blocks: number; bavail: number };

/** Free space of the volume holding `path`, 0–100, or null when it cannot be read. */
export function diskFreePercent(
  path: string,
  statfs: StatFs = fs.statfsSync as unknown as StatFs,
): number | null {
  try {
    const stats = statfs(path);
    return stats.blocks > 0 ? (stats.bavail / stats.blocks) * 100 : null;
  } catch {
    return null;
  }
}
