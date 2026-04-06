import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnStream, dockerRun } from "./docker.js";
import { loadDb, saveDb } from "./store.js";
import { newId } from "./auth.js";
import type { Project, Deployment } from "../types.js";

// ── Log Subscriber Registry ────────────────────────────────────────────────
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
  subscribers.get(deploymentId)?.forEach((fn) => fn(line));
}

// ── DB helpers ─────────────────────────────────────────────────────────────
function pushLog(deploymentId: string, line: string) {
  broadcast(deploymentId, line);
  const db = loadDb();
  const dep = db.deployments.find((d) => d.id === deploymentId);
  if (dep) {
    dep.logs.push(line);
    saveDb(db);
  }
}

function setDeploymentStatus(deploymentId: string, status: Deployment["status"]) {
  const db = loadDb();
  const dep = db.deployments.find((d) => d.id === deploymentId);
  if (dep) {
    dep.status = status;
    if (status === "live" || status === "failed") dep.finishedAt = Date.now();
    saveDb(db);
  }
}

function setProjectStatus(projectId: string, status: Project["status"], extra: Partial<Project> = {}) {
  const db = loadDb();
  const proj = db.projects.find((p) => p.id === projectId);
  if (proj) {
    Object.assign(proj, { status, updatedAt: Date.now(), ...extra });
    saveDb(db);
  }
}

// ── Main deploy function ───────────────────────────────────────────────────
export function createDeployment(project: Project, commitSha: string, triggeredBy: "manual" | "webhook" = "manual"): Deployment {
  const db = loadDb();
  const deployment: Deployment = {
    id: newId("dep"),
    projectId: project.id,
    commitSha,
    status: "queued",
    triggeredBy,
    imageTag: "",
    logs: [`[nexus] Deploy queued for ${project.name}`, `[nexus] repo=${project.repo} branch=${project.branch}`],
    createdAt: Date.now(),
  };
  db.deployments.unshift(deployment);
  saveDb(db);
  return deployment;
}

export async function runDeploy(project: Project, deploymentId: string): Promise<void> {
  const log = (line: string) => pushLog(deploymentId, line);
  const buildDir = path.join(os.tmpdir(), `nexus-build-${deploymentId}`);

  try {
    setDeploymentStatus(deploymentId, "building");
    setProjectStatus(project.id, "building");

    // ── 1. Clone ─────────────────────────────────────────────────────────
    log(`[nexus] Cloning ${project.repo} @ ${project.branch}…`);
    fs.mkdirSync(buildDir, { recursive: true });

    const repoUrl = project.repo.startsWith("http")
      ? project.repo
      : `https://github.com/${project.repo}`;

    await spawnStream(
      "git",
      ["clone", "--depth", "1", "--branch", project.branch, repoUrl, buildDir],
      log
    );

    log(`[nexus] ✓ Clone complete`);

    // ── 2. Build ──────────────────────────────────────────────────────────
    const imageTag = `nexus/${project.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}:${deploymentId.slice(-8)}`;
    log(`[nexus] Building image ${imageTag} with nixpacks…`);

    // Try nixpacks first, fall back to docker build if Dockerfile exists
    const hasDockerfile = fs.existsSync(path.join(buildDir, "Dockerfile"));
    const buildTool = hasDockerfile ? "docker" : "nixpacks";

    if (buildTool === "nixpacks") {
      await spawnStream("nixpacks", ["build", buildDir, "--name", imageTag], log);
    } else {
      await spawnStream("docker", ["build", "-t", imageTag, buildDir], log);
    }

    log(`[nexus] ✓ Image built: ${imageTag}`);

    // Update imageTag in deployment
    const db = loadDb();
    const dep = db.deployments.find((d) => d.id === deploymentId);
    if (dep) { dep.imageTag = imageTag; saveDb(db); }

    // ── 3. Env vars ───────────────────────────────────────────────────────
    const env: Record<string, string> = {
      PORT: "3000",
      NODE_ENV: "production",
      ...project.env,
    };

    // ── 4. Run container ──────────────────────────────────────────────────
    const baseDomain = process.env.BASE_DOMAIN ?? "localhost";
    const domain = `${project.name}.${baseDomain}`;
    const containerName = `nexus-app-${project.name}`;
    const network = process.env.DOCKER_NETWORK ?? "nexus-net";

    log(`[nexus] Starting container at ${domain}…`);

    const containerId = await dockerRun({
      image: imageTag,
      name: containerName,
      env,
      domain,
      port: 3000,
      network,
      onLine: log,
    });

    log(`[nexus] ✅ Live at https://${domain}`);

    // ── 5. Save ───────────────────────────────────────────────────────────
    setDeploymentStatus(deploymentId, "live");
    setProjectStatus(project.id, "live", { containerId, domain, imageTag });

  } catch (err: any) {
    log(`[nexus] ✗ Build failed: ${err?.message ?? err}`);
    setDeploymentStatus(deploymentId, "failed");
    setProjectStatus(project.id, "failed");
    throw err;
  } finally {
    // Cleanup build dir
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}
