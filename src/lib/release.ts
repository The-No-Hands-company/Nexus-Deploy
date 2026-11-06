/**
 * Turning an image into the version people are served.
 *
 * Blue/green: the new container starts on its own loopback port while the old
 * one keeps serving; only when the new one answers its health check is the
 * route switched, and only then does the old one stop. A release that never
 * becomes healthy is removed and nobody noticed.
 *
 * A project with a persistent volume cannot do that safely, because two
 * containers writing one volume (a SQLite file, say) can corrupt it. Those
 * release stop-then-start: a short outage, with the previous image put back if
 * the new one fails.
 *
 * Everything here talks to interfaces, so the whole policy is tested with
 * fakes. build.ts wires in the real Docker and the real publisher.
 */
import { type HealthResult, waitForHealthy } from "./health.js";
import type { RoutePublisher } from "./publisher.js";
import type { ContainerLimits } from "./safeguards.js";

export type ContainerSpec = {
  name: string;
  image: string;
  env: Record<string, string>;
  appPort: number;
  hostPort: number;
  limits: ContainerLimits;
  volume?: { name: string; path: string } | undefined;
};

export type ReleaseRuntime = {
  run(spec: ContainerSpec, onLine: (line: string) => void): Promise<string>;
  /** HTTP status of one probe on the loopback port, or null if nothing answered. */
  probe(hostPort: number, path: string): Promise<number | null>;
  status(name: string): Promise<string>;
  logTail(name: string): Promise<string[]>;
  remove(name: string): Promise<void>;
};

export type ReleaseProject = {
  id: string;
  slug: string;
  host: string;
  appPort: number;
  healthPath?: string | undefined;
  env: Record<string, string>;
  limits: ContainerLimits;
  /** Present when the project persists data: releases then stop-then-start. */
  volume?: { name: string; path: string } | undefined;
  /** What is serving right now, if anything. */
  current?: { containerName: string; imageRef: string; hostPort: number } | undefined;
};

export type ReleaseDeps = {
  runtime: ReleaseRuntime;
  publisher: RoutePublisher;
  allocatePort: () => Promise<number>;
  health: {
    timeoutMs: number;
    intervalMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  };
  /** How long the old container keeps running after the route has moved. */
  drainMs: number;
  sleep?: (ms: number) => Promise<void>;
  log: (line: string) => void;
};

export type ReleaseOutcome =
  | {
      ok: true;
      containerName: string;
      hostPort: number;
      imageRef: string;
      mode: "blue-green" | "stop-start";
    }
  | { ok: false; reason: string; servingPrevious: boolean };

export function releaseContainerName(slug: string, deploymentId: string): string {
  return `nexus-app-${slug}-${deploymentId.slice(-8)}`;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function startAndProve(
  project: ReleaseProject,
  name: string,
  imageRef: string,
  hostPort: number,
  deps: ReleaseDeps,
): Promise<HealthResult> {
  const { runtime, health, log } = deps;
  try {
    await runtime.run(
      {
        name,
        image: imageRef,
        env: { PORT: String(project.appPort), NODE_ENV: "production", ...project.env },
        appPort: project.appPort,
        hostPort,
        limits: project.limits,
        volume: project.volume,
      },
      log,
    );
  } catch (error) {
    return { ok: false, reason: `container did not start: ${(error as Error).message}` };
  }
  const healthPath = project.healthPath || "/";
  log(`[nexus] Waiting for ${healthPath} to answer on 127.0.0.1:${hostPort}…`);
  return waitForHealthy({
    probe: () => runtime.probe(hostPort, healthPath),
    isRunning: async () => ["running", "created"].includes(await runtime.status(name)),
    // A declared health path must answer 2xx; without one any non-5xx on "/" will do.
    requireOk: Boolean(project.healthPath),
    timeoutMs: health.timeoutMs,
    intervalMs: health.intervalMs,
    ...(health.now ? { now: health.now } : {}),
    ...(health.sleep ? { sleep: health.sleep } : {}),
  });
}

async function logFailure(name: string, deps: ReleaseDeps): Promise<void> {
  for (const line of await deps.runtime.logTail(name).catch(() => [] as string[])) {
    deps.log(`[app] ${line}`);
  }
}

export async function performRelease(
  project: ReleaseProject,
  deploymentId: string,
  imageRef: string,
  deps: ReleaseDeps,
): Promise<ReleaseOutcome> {
  const { runtime, publisher, log } = deps;
  const sleep = deps.sleep ?? wait;
  const name = releaseContainerName(project.slug, deploymentId);
  const previous = project.current;

  // A volume means one writer at a time: take the old container down first.
  if (project.volume && previous) {
    log(
      `[nexus] ${project.slug} keeps data on a volume, so the old release stops before the new one starts`,
    );
    await runtime.remove(previous.containerName);
  }

  const hostPort = await deps.allocatePort();
  log(`[nexus] Starting ${imageRef} on 127.0.0.1:${hostPort}`);
  const health = await startAndProve(project, name, imageRef, hostPort, deps);

  if (!health.ok) {
    log(`[nexus] ✗ Health check failed: ${health.reason}`);
    await logFailure(name, deps);
    await runtime.remove(name);

    if (project.volume && previous) {
      log(`[nexus] Restoring previous release → ${previous.imageRef}`);
      const restored = await startAndProve(
        project,
        previous.containerName,
        previous.imageRef,
        previous.hostPort,
        deps,
      );
      if (restored.ok) {
        log("[nexus] ✓ Previous release is serving again");
        return { ok: false, reason: health.reason, servingPrevious: true };
      }
      log(`[nexus] ✗ Previous release is unhealthy too: ${restored.reason}`);
      await runtime.remove(previous.containerName);
      return { ok: false, reason: health.reason, servingPrevious: false };
    }
    return { ok: false, reason: health.reason, servingPrevious: Boolean(previous) };
  }

  try {
    await publisher.publish({
      projectId: project.id,
      slug: project.slug,
      host: project.host,
      hostPort,
    });
  } catch (error) {
    const reason = `could not publish the route: ${(error as Error).message}`;
    log(`[nexus] ✗ ${reason}`);
    await runtime.remove(name);
    return { ok: false, reason, servingPrevious: Boolean(previous) && !project.volume };
  }

  if (previous && !project.volume && previous.containerName !== name) {
    log(`[nexus] Route moved; stopping the old release in ${Math.round(deps.drainMs / 1000)}s`);
    await sleep(deps.drainMs);
    await runtime.remove(previous.containerName);
  }

  return {
    ok: true,
    containerName: name,
    hostPort,
    imageRef,
    mode: project.volume ? "stop-start" : "blue-green",
  };
}
