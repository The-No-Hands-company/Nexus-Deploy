import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnStream, dockerRun } from "./docker.js";
import { loadDb, writeDb, trimDeployments, capLogs } from "./store.js";
import { newId } from "./auth.js";
import { config } from "./config.js";
import type { Project, Deployment } from "../types.js";

// ── Log subscriber registry ────────────────────────────────────────────────
type Subscriber = (line: string) => void;
const subscribers = new Map<string, Set<Subscriber>>();

export function subscribeToDeployment(deploymentId: string, fn: Subscriber): () => void {
  if (!subscribers.has(deploymentId)) subscribers.set(deploymentId, new Set());
  subscribers.get(deploymentId)!.add(fn);
  return () => {
    subscribers.get(deploymentId)?.delete(fn);
    if (subscribers.get(deploymentId)?.size === 0) subscribers.delete(deploymentId);
  };
}

function broadcast(deploymentId: string, line: string) {
  subscribers.get(deploymentId)?.forEach(fn => fn(line));
}

// ── Per-project build lock ─────────────────────────────────────────────────
const buildingProjects = new Set<string>();

export function isBuilding(projectId: string): boolean {
  return buildingProjects.has(projectId);
}

// ── DB helpers (all through write queue) ──────────────────────────────────
async function pushLog(deploymentId: string, line: string): Promise<void> {
  broadcast(deploymentId, line);
  await writeDb(db => {
    const dep = db.deployments.find(d => d.id === deploymentId);
    if (!dep) return;
    dep.logs.push(line);
    dep.logs = capLogs(dep.logs);
  });
}

async function setDepStatus(deploymentId: string, status: Deployment["status"]): Promise<void> {
  await writeDb(db => {
    const dep = db.deployments.find(d => d.id === deploymentId);
    if (!dep) return;
    dep.status = status;
    if (status === "live" || status === "failed") dep.finishedAt = Date.now();
  });
}

async function setProjStatus(projectId: string, status: Project["status"], extra: Partial<Project> = {}): Promise<void> {
  await writeDb(db => {
    const proj = db.projects.find(p => p.id === projectId);
    if (!proj) return;
    Object.assign(proj, { status, updatedAt: Date.now(), ...extra });
  });
}

// ── Create deployment record ───────────────────────────────────────────────
export function createDeployment(
  project: Project,
  commitSha: string,
  triggeredBy: DeployTrigger = "manual"
): Deployment {
  const deployment: Deployment = {
    id: newId("dep"),
    projectId: project.id,
    commitSha,
    triggeredBy,
    status: "queued",
    imageTag: "",
    logs: [
      `[nexus] Deploy queued for ${project.name}`,
      `[nexus] repo=${project.repo}  branch=${project.branch}`,
    ],
    createdAt: Date.now(),
  };
  // Synchronous first write — only call from non-concurrent context (route handler)
  const db = loadDb();
  db.deployments.unshift(deployment);
  // Flush synchronously so the route handler can return the ID immediately
  import("./store.js").then(({ saveDb }) => saveDb(db));
  return deployment;
}

// Re-export trigger type so importers don't need types.ts
import type { DeployTrigger } from "../types.js";

// ── Full build + deploy ────────────────────────────────────────────────────
export async function runDeploy(project: Project, deploymentId: string): Promise<void> {
  if (buildingProjects.has(project.id)) {
    await pushLog(deploymentId, "[nexus] ✗ Another build is already running for this project");
    await setDepStatus(deploymentId, "failed");
    return;
  }

  buildingProjects.add(project.id);
  const buildDir = path.join(os.tmpdir(), `nexus-build-${deploymentId}`);

  try {
    const log = (line: string) => pushLog(deploymentId, line);

    await setDepStatus(deploymentId, "building");
    await setProjStatus(project.id, "building");

    // 1. Clone ──────────────────────────────────────────────────────────────
    log(`[nexus] Cloning ${project.repo} @ ${project.branch}…`);
    fs.mkdirSync(buildDir, { recursive: true });

    const repoUrl = project.repo.startsWith("http")
      ? project.repo
      : `https://github.com/${project.repo}`;

    await spawnStream("git", ["clone", "--depth", "1", "--branch", project.branch, repoUrl, buildDir], log);
    log(`[nexus] ✓ Clone complete`);

    // 2. Build ──────────────────────────────────────────────────────────────
    const imageTag = `nexus/${project.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}:${deploymentId.slice(-8)}`;
    const hasDockerfile = fs.existsSync(path.join(buildDir, "Dockerfile"));
    log(`[nexus] Building with ${hasDockerfile ? "Docker" : "Nixpacks"} → ${imageTag}`);

    if (hasDockerfile) {
      await spawnStream("docker", ["build", "-t", imageTag, buildDir], log);
    } else {
      await spawnStream("nixpacks", ["build", buildDir, "--name", imageTag], log);
    }
    log(`[nexus] ✓ Image built`);

    // Persist imageTag
    await writeDb(db => {
      const dep = db.deployments.find(d => d.id === deploymentId);
      if (dep) dep.imageTag = imageTag;
    });

    await runContainer(project, deploymentId, imageTag, log);

  } catch (err: any) {
    const msg = err?.message ?? String(err);
    await pushLog(deploymentId, `[nexus] ✗ Build failed: ${msg}`);
    await setDepStatus(deploymentId, "failed");
    await setProjStatus(project.id, "failed");
  } finally {
    buildingProjects.delete(project.id);
    fs.rmSync(buildDir, { recursive: true, force: true });
    // Trim old deployments in the background
    trimDeployments(project.id).catch(() => {});
  }
}

// ── Rollback ───────────────────────────────────────────────────────────────
export async function runRollback(project: Project, deploymentId: string, imageTag: string): Promise<void> {
  if (buildingProjects.has(project.id)) return;
  buildingProjects.add(project.id);

  try {
    const log = (line: string) => pushLog(deploymentId, line);
    await setDepStatus(deploymentId, "building");
    await setProjStatus(project.id, "building");
    log(`[nexus] Rolling back to image ${imageTag}…`);
    await runContainer(project, deploymentId, imageTag, log);
  } catch (err: any) {
    await pushLog(deploymentId, `[nexus] ✗ Rollback failed: ${err?.message}`);
    await setDepStatus(deploymentId, "failed");
    await setProjStatus(project.id, "failed");
  } finally {
    buildingProjects.delete(project.id);
  }
}

// ── Shared: start container + update DB ───────────────────────────────────
async function runContainer(
  project: Project,
  deploymentId: string,
  imageTag: string,
  log: (l: string) => Promise<void>
) {
  const env: Record<string, string> = {
    PORT: String(project.port ?? 3000),
    NODE_ENV: "production",
    ...project.env,
  };
  const domain = `${project.name}.${config.baseDomain}`;
  const containerName = `nexus-app-${project.name}`;

  log(`[nexus] Starting container → https://${domain}`);

  const containerId = await dockerRun({
    image: imageTag,
    name: containerName,
    env,
    domain,
    port: project.port ?? 3000,
    network: config.dockerNetwork,
    onLine: log,
  });

  log(`[nexus] ✅ Live at https://${domain}`);

  await setDepStatus(deploymentId, "live");
  await setProjStatus(project.id, "live", { containerId, domain, imageTag });
}
