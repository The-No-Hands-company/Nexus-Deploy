import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DeployTrigger, Deployment, GitSource, Project } from "../types.js";
import { newId } from "./auth.js";
import { resolveBuildContext, resolveDockerfile, validateDockerfile } from "./build-context.js";
import { type BuildOptions, type Track, buildImage, cloneRepo, pullImage } from "./build-steps.js";
import { config } from "./config.js";
import { dockerReleaseRuntime } from "./docker-runtime.js";
import { emitStatusChange } from "./events.js";
import { evaluateBuildGuard } from "./guard.js";
import { type PortRange, appHost } from "./hosts.js";
import { allocatePort, loopbackPortFree, portsInUse } from "./ports.js";
import { NullPublisher, type RoutePublisher } from "./publisher.js";
import { type ReleaseProject, type ReleaseRuntime, performRelease } from "./release.js";
import { type Limits, type Verdict, containerLimits, diskFreePercent } from "./safeguards.js";
import { pinnedImageRef, redact, sourceOf } from "./source.js";
import { capLogs, loadDb, saveDb, trimDeployments, writeDb } from "./store.js";

export { resolveBuildContext } from "./build-context.js";

type LogFn = (line: string) => void;

/** Everything the pipeline does to the outside world, replaceable in tests. */
export type DeploySteps = {
  clone: (source: GitSource, dir: string, log: LogFn, track: Track) => Promise<void>;
  buildImage: (opts: BuildOptions, log: LogFn, track: Track) => Promise<void>;
  pullImage: (image: string, log: LogFn, timeoutMs: number) => Promise<string>;
};

export type DeployDeps = {
  steps: DeploySteps;
  runtime: ReleaseRuntime;
  publisher: RoutePublisher;
  limits: Limits;
  baseDomain: string;
  hostPattern: string;
  portRange: PortRange;
  isPortFree: (port: number) => Promise<boolean>;
  health: { timeoutMs: number; intervalMs: number };
  drainMs: number;
  tmpDir: string;
};

// The ingress is told about live apps through this. The reference node installs
// a publisher that registers routes with Nexus Cloud; until one is installed
// nothing is announced, which is correct for a node with no ingress to tell.
let routePublisher: RoutePublisher = new NullPublisher();
export function setRoutePublisher(publisher: RoutePublisher): void {
  routePublisher = publisher;
}
export function getRoutePublisher(): RoutePublisher {
  return routePublisher;
}

export function defaultDeps(): DeployDeps {
  return {
    steps: {
      clone: (source, dir, log, track) =>
        cloneRepo(source, dir, config.allowLocalRepos, log, track),
      buildImage,
      pullImage,
    },
    runtime: dockerReleaseRuntime,
    publisher: routePublisher,
    limits: config.limits,
    baseDomain: config.baseDomain,
    hostPattern: config.appHostPattern,
    portRange: config.appPortRange,
    isPortFree: loopbackPortFree,
    health: { timeoutMs: config.healthTimeoutMs, intervalMs: config.healthIntervalMs },
    drainMs: 10_000,
    tmpDir: os.tmpdir(),
  };
}

// ── Log subscriber registry ────────────────────────────────────────────────
type Subscriber = (line: string) => void;
const subscribers = new Map<string, Set<Subscriber>>();

export function subscribeToDeployment(id: string, fn: Subscriber): () => void {
  if (!subscribers.has(id)) subscribers.set(id, new Set());
  subscribers.get(id)?.add(fn);
  return () => {
    subscribers.get(id)?.delete(fn);
    if (!subscribers.get(id)?.size) subscribers.delete(id);
  };
}

function broadcast(id: string, line: string) {
  for (const fn of subscribers.get(id) ?? []) fn(line);
}

// ── Per-project build lock ─────────────────────────────────────────────────
const buildingProjects = new Set<string>();
export function isBuilding(projectId: string) {
  return buildingProjects.has(projectId);
}

// ── Per-deployment cancel registry ────────────────────────────────────────
const buildCancellers = new Map<string, () => void>();

export async function cancelBuild(deploymentId: string): Promise<boolean> {
  const kill = buildCancellers.get(deploymentId);
  if (!kill) return false;
  kill();
  return true;
}

// ── DB helpers ─────────────────────────────────────────────────────────────
async function pushLog(depId: string, line: string) {
  broadcast(depId, line);
  await writeDb((db) => {
    const dep = db.deployments.find((d) => d.id === depId);
    if (dep) dep.logs = capLogs([...dep.logs, line]);
  });
}

async function setDepStatus(depId: string, status: Deployment["status"]) {
  await writeDb((db) => {
    const dep = db.deployments.find((d) => d.id === depId);
    if (dep) {
      dep.status = status;
      if (status === "live" || status === "failed" || status === "cancelled")
        dep.finishedAt = Date.now();
    }
  });
}

async function setProjStatus(
  projectId: string,
  status: Project["status"],
  extra: Partial<Project> = {},
) {
  await writeDb((db) => {
    const p = db.projects.find((p) => p.id === projectId);
    if (p) Object.assign(p, { status, updatedAt: Date.now(), ...extra });
  });
  emitStatusChange(projectId, status);
}

// ── May this project build right now? ──────────────────────────────────────
function lowestPercent(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? Math.min(...known) : null;
}

export function guardBuild(project: Project, now: number = Date.now()): Verdict {
  const sandboxFree = config.sandboxStoragePath ? diskFreePercent(config.sandboxStoragePath) : null;
  return evaluateBuildGuard(
    loadDb(),
    project,
    {
      isBuilding,
      hostFreePercent: lowestPercent([
        diskFreePercent(config.dataDir),
        diskFreePercent(os.tmpdir()),
      ]),
      sandboxUsedPercent: sandboxFree === null ? null : 100 - sandboxFree,
      now,
    },
    config.limits,
  );
}

// ── Create deployment ──────────────────────────────────────────────────────
export function createDeployment(
  project: Project,
  commitSha: string,
  triggeredBy: DeployTrigger = "manual",
): Deployment {
  const source = sourceOf(project);
  const dep: Deployment = {
    id: newId("dep"),
    projectId: project.id,
    commitSha,
    triggeredBy,
    status: "queued",
    imageTag: "",
    logs: [
      `[nexus] Deploy queued → ${project.name}`,
      source.type === "git"
        ? `[nexus] repo=${source.repo}  branch=${source.branch}`
        : `[nexus] image=${source.image}`,
    ],
    createdAt: Date.now(),
  };
  const db = loadDb();
  db.deployments.unshift(dep);
  saveDb(db);
  return dep;
}

// ── Notification webhook ───────────────────────────────────────────────────
async function notify(project: Project, deployment: Deployment) {
  if (!project.notifyUrl) return;
  const duration = deployment.finishedAt
    ? Math.round((deployment.finishedAt - deployment.createdAt) / 1000)
    : null;
  const body = {
    project: project.name,
    status: deployment.status,
    deploymentId: deployment.id,
    commitSha: deployment.commitSha,
    triggeredBy: deployment.triggeredBy,
    url: project.domain ? `https://${project.domain}` : null,
    duration,
    timestamp: new Date().toISOString(),
  };
  // Discord-compatible: wrap in "content" if URL contains discord.com
  const payload = project.notifyUrl.includes("discord.com")
    ? {
        content: `**${project.name}** deploy **${deployment.status}** — ${deployment.commitSha.slice(0, 8)} (${duration}s)`,
      }
    : body;
  try {
    await fetch(project.notifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn(`[nexus] Notify failed for ${project.name}: ${(e as Error).message}`);
  }
}

// ── Ports: one release at a time picks, and holds its pick ─────────────────
let portChain: Promise<unknown> = Promise.resolve();
function reservePort(projectId: string, deps: DeployDeps): Promise<number> {
  const attempt = portChain.then(async () => {
    const port = await allocatePort(deps.portRange, portsInUse(loadDb().projects), deps.isPortFree);
    if (port === null) throw new Error("no free port is left in the app port range");
    await writeDb((db) => {
      const p = db.projects.find((p) => p.id === projectId);
      if (p) p.pendingPort = port;
    });
    return port;
  });
  portChain = attempt.catch(() => {});
  return attempt;
}

// ── Release: start the image, prove it, move the route ─────────────────────
async function release(
  snapshot: Project,
  deploymentId: string,
  imageRef: string,
  deps: DeployDeps,
  log: LogFn,
): Promise<void> {
  const project = loadDb().projects.find((p) => p.id === snapshot.id) ?? snapshot;
  const host = appHost(project.name, deps.hostPattern, deps.baseDomain);
  const hasVolume = Boolean(project.volumePath) && project.volumePath !== "/workspace";
  const releaseProject: ReleaseProject = {
    id: project.id,
    slug: project.name,
    host,
    appPort: project.port ?? 3000,
    healthPath: project.healthPath,
    env: project.env,
    limits: containerLimits(project, deps.limits),
    volume: hasVolume ? { name: `nexus-vol-${project.name}`, path: project.volumePath } : undefined,
    current:
      project.containerName && project.hostPort !== undefined && project.imageTag
        ? {
            containerName: project.containerName,
            imageRef: project.imageTag,
            hostPort: project.hostPort,
          }
        : undefined,
  };

  try {
    const outcome = await performRelease(releaseProject, deploymentId, imageRef, {
      runtime: deps.runtime,
      publisher: deps.publisher,
      allocatePort: () => reservePort(project.id, deps),
      health: deps.health,
      drainMs: deps.drainMs,
      log,
    });
    if (outcome.ok) {
      await setDepStatus(deploymentId, "live");
      await setProjStatus(project.id, "live", {
        containerName: outcome.containerName,
        hostPort: outcome.hostPort,
        imageTag: outcome.imageRef,
        previousImageTag:
          project.imageTag && project.imageTag !== outcome.imageRef
            ? project.imageTag
            : project.previousImageTag,
        domain: host,
      });
      log(`[nexus] ✅ Live at https://${host}`);
      return;
    }
    log(`[nexus] ✗ Release rejected: ${outcome.reason}`);
    await setDepStatus(deploymentId, "failed");
    if (outcome.servingPrevious) {
      await setProjStatus(project.id, "live");
    } else {
      if (releaseProject.current) await deps.publisher.unpublish(project.name).catch(() => {});
      await setProjStatus(project.id, "failed", { containerName: undefined, hostPort: undefined });
    }
  } finally {
    await writeDb((db) => {
      const p = db.projects.find((p) => p.id === project.id);
      if (p) p.pendingPort = undefined;
    });
  }
}

/** A project that was serving keeps serving when a build fails before the release. */
function wasServing(project: Project): boolean {
  return project.status === "live" && Boolean(project.containerName);
}

// ── Full build pipeline ────────────────────────────────────────────────────
export async function runDeploy(
  project: Project,
  deploymentId: string,
  deps: DeployDeps = defaultDeps(),
): Promise<void> {
  if (buildingProjects.has(project.id)) {
    await pushLog(deploymentId, "[nexus] ✗ Another build is already running");
    await setDepStatus(deploymentId, "failed");
    return;
  }
  buildingProjects.add(project.id);

  const source = sourceOf(project);
  const secrets = [source.type === "git" ? source.token : undefined];
  const emit = (line: string) => pushLog(deploymentId, redact(line, secrets));
  const buildDir = path.join(deps.tmpDir, `nexus-build-${deploymentId}`);
  const servedBefore = wasServing(project);
  let cancelled = false;
  let timedOut = false;

  const killFns: Array<() => void> = [];
  const track: Track = (kill) => {
    killFns.push(kill);
  };
  const stopSteps = () => {
    for (const kill of killFns) kill();
  };
  buildCancellers.set(deploymentId, () => {
    cancelled = true;
    stopSteps();
  });
  const log: LogFn = (line) => {
    if (!cancelled) void emit(line);
  };
  const assertActive = () => {
    if (cancelled) throw new Error("cancelled");
    if (timedOut) throw new Error("timed out");
  };
  let timer: NodeJS.Timeout | undefined;

  try {
    await setDepStatus(deploymentId, "building");
    await setProjStatus(project.id, "building");
    timer = setTimeout(() => {
      timedOut = true;
      stopSteps();
    }, deps.limits.buildTimeoutMs);

    let imageRef: string;
    if (source.type === "git") {
      log(`[nexus] Cloning ${source.repo} @ ${source.branch}…`);
      fs.mkdirSync(buildDir, { recursive: true });
      await deps.steps.clone(source, buildDir, log, track);
      assertActive();
      log("[nexus] ✓ Clone complete");

      const tag = `nexus/${project.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}:${deploymentId.slice(-8)}`;
      const contextDir = resolveBuildContext(buildDir, project.buildContext);
      const dockerfile = resolveDockerfile(
        buildDir,
        validateDockerfile(project.dockerfile, project.buildContext ?? "."),
      );
      log(`[nexus] Building with ${dockerfile ? "Docker" : "Railpack"} → ${tag}`);
      await deps.steps.buildImage({ contextDir, dockerfile, tag }, log, track);
      assertActive();
      log("[nexus] ✓ Image built");
      imageRef = tag;
    } else {
      log(`[nexus] Pulling ${source.image}…`);
      const digest = await deps.steps.pullImage(source.image, log, deps.limits.pullTimeoutMs);
      assertActive();
      imageRef = pinnedImageRef(source.image, digest);
      log(`[nexus] ✓ Pulled ${imageRef}`);
    }
    clearTimeout(timer);

    await writeDb((db) => {
      const d = db.deployments.find((d) => d.id === deploymentId);
      if (d) d.imageTag = imageRef;
    });
    await release(project, deploymentId, imageRef, deps, log);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    let status: Deployment["status"] = "failed";
    if (cancelled || message === "cancelled") {
      status = "cancelled";
      await emit("[nexus] ✗ Build cancelled");
    } else if (timedOut) {
      await emit(
        `[nexus] ✗ Build exceeded ${Math.round(deps.limits.buildTimeoutMs / 60_000)} minutes and was stopped`,
      );
    } else {
      await emit(`[nexus] ✗ Build failed: ${message}`);
    }
    await setDepStatus(deploymentId, status);
    await setProjStatus(project.id, servedBefore ? "live" : "failed");
  } finally {
    if (timer) clearTimeout(timer);
    buildCancellers.delete(deploymentId);
    buildingProjects.delete(project.id);
    fs.rmSync(buildDir, { recursive: true, force: true });
    trimDeployments(project.id).catch(() => {});
    const dep = loadDb().deployments.find((d) => d.id === deploymentId);
    if (dep) notify(project, dep).catch(() => {});
  }
}

// ── Rollback ───────────────────────────────────────────────────────────────
export async function runRollback(
  project: Project,
  deploymentId: string,
  imageRef: string,
  deps: DeployDeps = defaultDeps(),
): Promise<void> {
  if (buildingProjects.has(project.id)) return;
  buildingProjects.add(project.id);
  const servedBefore = wasServing(project);
  try {
    const log: LogFn = (line) => {
      void pushLog(deploymentId, line);
    };
    await setDepStatus(deploymentId, "building");
    await setProjStatus(project.id, "building");
    log(`[nexus] Rolling back → ${imageRef}`);
    await release(project, deploymentId, imageRef, deps, log);
  } catch (err) {
    await pushLog(deploymentId, `[nexus] ✗ Rollback failed: ${(err as Error)?.message}`);
    await setDepStatus(deploymentId, "failed");
    await setProjStatus(project.id, servedBefore ? "live" : "failed");
  } finally {
    buildingProjects.delete(project.id);
    const dep = loadDb().deployments.find((d) => d.id === deploymentId);
    if (dep) notify(project, dep).catch(() => {});
  }
}
