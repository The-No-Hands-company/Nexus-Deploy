import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnStream, dockerRun } from "./docker.js";
import { loadDb, saveDb } from "./store.js";
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

// ── DB helpers ─────────────────────────────────────────────────────────────
function pushLog(deploymentId: string, line: string) {
  broadcast(deploymentId, line);
  const db = loadDb();
  const dep = db.deployments.find(d => d.id === deploymentId);
  if (dep) { dep.logs.push(line); saveDb(db); }
}

function setDepStatus(deploymentId: string, status: Deployment["status"]) {
  const db = loadDb();
  const dep = db.deployments.find(d => d.id === deploymentId);
  if (dep) {
    dep.status = status;
    if (status === "live" || status === "failed") dep.finishedAt = Date.now();
    saveDb(db);
  }
}

function setProjStatus(projectId: string, status: Project["status"], extra: Partial<Project> = {}) {
  const db = loadDb();
  const proj = db.projects.find(p => p.id === projectId);
  if (proj) { Object.assign(proj, { status, updatedAt: Date.now(), ...extra }); saveDb(db); }
}

// ── Create deployment record ───────────────────────────────────────────────
export function createDeployment(
  project: Project,
  commitSha: string,
  triggeredBy: "manual" | "webhook" | "rollback" = "manual"
): Deployment {
  const db = loadDb();
  const deployment: Deployment = {
    id: newId("dep"),
    projectId: project.id,
    commitSha,
    triggeredBy,
    status: "queued",
    imageTag: "",
    logs: [
      `[nexus] Deploy queued for ${project.name}`,
      `[nexus] repo=${project.repo} branch=${project.branch}`,
    ],
    createdAt: Date.now(),
  };
  db.deployments.unshift(deployment);
  saveDb(db);
  return deployment;
}

// ── Full build + deploy ────────────────────────────────────────────────────
export async function runDeploy(project: Project, deploymentId: string): Promise<void> {
  const log = (line: string) => pushLog(deploymentId, line);
  const buildDir = path.join(os.tmpdir(), `nexus-build-${deploymentId}`);

  try {
    setDepStatus(deploymentId, "building");
    setProjStatus(project.id, "building");

    // 1. Clone
    log(`[nexus] Cloning ${project.repo} @ ${project.branch}…`);
    fs.mkdirSync(buildDir, { recursive: true });

    const repoUrl = project.repo.startsWith("http")
      ? project.repo
      : `https://github.com/${project.repo}`;

    await spawnStream("git", ["clone", "--depth", "1", "--branch", project.branch, repoUrl, buildDir], log);
    log(`[nexus] ✓ Clone complete`);

    // 2. Build
    const imageTag = `nexus/${project.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}:${deploymentId.slice(-8)}`;
    log(`[nexus] Building image ${imageTag}…`);

    const hasDockerfile = fs.existsSync(path.join(buildDir, "Dockerfile"));
    if (hasDockerfile) {
      await spawnStream("docker", ["build", "-t", imageTag, buildDir], log);
    } else {
      await spawnStream("nixpacks", ["build", buildDir, "--name", imageTag], log);
    }

    log(`[nexus] ✓ Image built: ${imageTag}`);

    // Persist imageTag
    const db1 = loadDb();
    const dep1 = db1.deployments.find(d => d.id === deploymentId);
    if (dep1) { dep1.imageTag = imageTag; saveDb(db1); }

    await runContainer(project, deploymentId, imageTag, log);

  } catch (err: any) {
    log(`[nexus] ✗ Deploy failed: ${err?.message ?? String(err)}`);
    setDepStatus(deploymentId, "failed");
    setProjStatus(project.id, "failed");
  } finally {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

// ── Rollback — re-run an existing image ───────────────────────────────────
export async function runRollback(project: Project, deploymentId: string, imageTag: string): Promise<void> {
  const log = (line: string) => pushLog(deploymentId, line);
  try {
    setDepStatus(deploymentId, "building");
    setProjStatus(project.id, "building");
    log(`[nexus] Rolling back to image ${imageTag}…`);
    await runContainer(project, deploymentId, imageTag, log);
  } catch (err: any) {
    log(`[nexus] ✗ Rollback failed: ${err?.message ?? String(err)}`);
    setDepStatus(deploymentId, "failed");
    setProjStatus(project.id, "failed");
  }
}

// ── Shared: start container + update DB ───────────────────────────────────
async function runContainer(
  project: Project,
  deploymentId: string,
  imageTag: string,
  log: (l: string) => void
) {
  const env: Record<string, string> = { PORT: "3000", NODE_ENV: "production", ...project.env };
  const domain = `${project.name}.${config.baseDomain}`;
  const containerName = `nexus-app-${project.name}`;

  log(`[nexus] Starting container at ${domain}…`);

  const containerId = await dockerRun({
    image: imageTag,
    name: containerName,
    env,
    domain,
    port: 3000,
    network: config.dockerNetwork,
    onLine: log,
  });

  log(`[nexus] ✅ Live at https://${domain}`);

  setDepStatus(deploymentId, "live");
  setProjStatus(project.id, "live", { containerId, domain, imageTag });
}
