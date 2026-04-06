import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnStream, spawnStreaming, dockerRun } from "./docker.js";
import { loadDb, writeDb, trimDeployments, capLogs, saveDb } from "./store.js";
import { newId } from "./auth.js";
import { config } from "./config.js";
import { emitStatusChange } from "./events.js";
import type { Project, Deployment, DeployTrigger } from "../types.js";

// ── Log subscriber registry ────────────────────────────────────────────────
type Subscriber = (line: string) => void;
const subscribers = new Map<string, Set<Subscriber>>();

export function subscribeToDeployment(id: string, fn: Subscriber): () => void {
  if (!subscribers.has(id)) subscribers.set(id, new Set());
  subscribers.get(id)!.add(fn);
  return () => { subscribers.get(id)?.delete(fn); if (!subscribers.get(id)?.size) subscribers.delete(id); };
}

function broadcast(id: string, line: string) {
  subscribers.get(id)?.forEach(fn => fn(line));
}

// ── Per-project build lock ─────────────────────────────────────────────────
const buildingProjects = new Set<string>();
export function isBuilding(projectId: string) { return buildingProjects.has(projectId); }

// ── Per-deployment cancel registry ────────────────────────────────────────
// Stores a kill() fn for each active build so it can be cancelled
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
  await writeDb(db => {
    const dep = db.deployments.find(d => d.id === depId);
    if (dep) dep.logs = capLogs([...dep.logs, line]);
  });
}

async function setDepStatus(depId: string, status: Deployment["status"]) {
  await writeDb(db => {
    const dep = db.deployments.find(d => d.id === depId);
    if (dep) {
      dep.status = status;
      if (status === "live" || status === "failed" || status === "cancelled") dep.finishedAt = Date.now();
    }
  });
}

async function setProjStatus(projectId: string, status: Project["status"], extra: Partial<Project> = {}) {
  await writeDb(db => {
    const p = db.projects.find(p => p.id === projectId);
    if (p) Object.assign(p, { status, updatedAt: Date.now(), ...extra });
  });
  emitStatusChange(projectId, status);
}

// ── Create deployment ──────────────────────────────────────────────────────
export function createDeployment(project: Project, commitSha: string, triggeredBy: DeployTrigger = "manual"): Deployment {
  const dep: Deployment = {
    id: newId("dep"),
    projectId: project.id,
    commitSha,
    triggeredBy,
    status: "queued",
    imageTag: "",
    logs: [
      `[nexus] Deploy queued → ${project.name}`,
      `[nexus] repo=${project.repo}  branch=${project.branch}`,
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
    ? { content: `**${project.name}** deploy **${deployment.status}** — ${deployment.commitSha.slice(0, 8)} (${duration}s)` }
    : body;
  try {
    await fetch(project.notifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e: any) {
    console.warn(`[nexus] Notify failed for ${project.name}: ${e.message}`);
  }
}

// ── Full build pipeline ────────────────────────────────────────────────────
export async function runDeploy(project: Project, deploymentId: string): Promise<void> {
  if (buildingProjects.has(project.id)) {
    await pushLog(deploymentId, "[nexus] ✗ Another build is already running");
    await setDepStatus(deploymentId, "failed");
    return;
  }
  buildingProjects.add(project.id);
  const buildDir = path.join(os.tmpdir(), `nexus-build-${deploymentId}`);
  let cancelled = false;

  // Register a cancel function
  const killFns: Array<() => void> = [];
  buildCancellers.set(deploymentId, () => {
    cancelled = true;
    killFns.forEach(fn => fn());
  });

  try {
    const log = (line: string) => { if (!cancelled) pushLog(deploymentId, line); };
    await setDepStatus(deploymentId, "building");
    await setProjStatus(project.id, "building");

    // 1. Clone
    log(`[nexus] Cloning ${project.repo} @ ${project.branch}…`);
    fs.mkdirSync(buildDir, { recursive: true });
    const repoUrl = project.repo.startsWith("http") ? project.repo : `https://github.com/${project.repo}`;

    await new Promise<void>((resolve, reject) => {
      const kill = spawnStreaming("git", ["clone", "--depth", "1", "--branch", project.branch, repoUrl, buildDir], log,
        err => { if (cancelled) resolve(); else if (err) reject(err); else resolve(); });
      killFns.push(kill);
    });
    if (cancelled) throw new Error("cancelled");
    log(`[nexus] ✓ Clone complete`);

    // 2. Build image
    const imageTag = `nexus/${project.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}:${deploymentId.slice(-8)}`;
    const hasDockerfile = fs.existsSync(path.join(buildDir, "Dockerfile"));
    log(`[nexus] Building with ${hasDockerfile ? "Docker" : "Nixpacks"} → ${imageTag}`);

    await new Promise<void>((resolve, reject) => {
      const cmd = hasDockerfile ? "docker" : "nixpacks";
      const args = hasDockerfile ? ["build", "-t", imageTag, buildDir] : ["build", buildDir, "--name", imageTag];
      const kill = spawnStreaming(cmd, args, log,
        err => { if (cancelled) resolve(); else if (err) reject(err); else resolve(); });
      killFns.push(kill);
    });
    if (cancelled) throw new Error("cancelled");
    log(`[nexus] ✓ Image built`);

    await writeDb(db => { const d = db.deployments.find(d => d.id === deploymentId); if (d) d.imageTag = imageTag; });
    await runContainer(project, deploymentId, imageTag, log);

  } catch (err: any) {
    if (cancelled || err?.message === "cancelled") {
      await pushLog(deploymentId, `[nexus] ✗ Build cancelled`);
      await setDepStatus(deploymentId, "cancelled");
      await setProjStatus(project.id, "failed");
    } else {
      await pushLog(deploymentId, `[nexus] ✗ Build failed: ${err?.message ?? String(err)}`);
      await setDepStatus(deploymentId, "failed");
      await setProjStatus(project.id, "failed");
    }
  } finally {
    buildCancellers.delete(deploymentId);
    buildingProjects.delete(project.id);
    fs.rmSync(buildDir, { recursive: true, force: true });
    trimDeployments(project.id).catch(() => {});
    // Send notification
    const dep = loadDb().deployments.find(d => d.id === deploymentId);
    if (dep) notify(project, dep).catch(() => {});
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
    log(`[nexus] Rolling back → ${imageTag}`);
    await runContainer(project, deploymentId, imageTag, log);
  } catch (err: any) {
    await pushLog(deploymentId, `[nexus] ✗ Rollback failed: ${err?.message}`);
    await setDepStatus(deploymentId, "failed");
    await setProjStatus(project.id, "failed");
  } finally {
    buildingProjects.delete(project.id);
    const dep = loadDb().deployments.find(d => d.id === deploymentId);
    if (dep) notify(project, dep).catch(() => {});
  }
}

// ── Shared: start container ────────────────────────────────────────────────
async function runContainer(project: Project, deploymentId: string, imageTag: string, log: (l: string) => void) {
  const env: Record<string, string> = { PORT: String(project.port ?? 3000), NODE_ENV: "production", ...project.env };
  const domain = project.customDomain ?? `${project.name}.${config.baseDomain}`;
  const containerName = `nexus-app-${project.name}`;

  // Named volume for persistence across redeploys
  const volumes: string[] = [];
  if (project.volumePath && project.volumePath !== "/workspace") {
    volumes.push(`nexus-vol-${project.name}:${project.volumePath}`);
  }

  log(`[nexus] Starting container → https://${domain}`);
  const containerId = await dockerRun({
    image: imageTag,
    name: containerName,
    env,
    domain,
    port: project.port ?? 3000,
    network: config.dockerNetwork,
    onLine: log,
    volumes,
    memoryLimit: project.memoryLimit || undefined,
    cpus: project.cpus || undefined,
  });
  log(`[nexus] ✅ Live at https://${domain}`);

  await setDepStatus(deploymentId, "live");
  await setProjStatus(project.id, "live", { containerId, domain, imageTag });
}
