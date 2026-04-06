/**
 * Background status sync — polls Docker every 30s and corrects project
 * status in the DB when reality diverges from what we have stored.
 * Also prunes old nexus Docker images once per hour.
 */
import { writeDb, loadDb } from "./store.js";
import { dockerStatus, spawnStream } from "./docker.js";
import { isBuilding } from "./build.js";
import { emitStatusChange } from "./events.js";

const DOCKER_TO_PROJECT: Record<string, string> = {
  running: "live",
  exited:  "stopped",
  paused:  "stopped",
  dead:    "failed",
  missing: "stopped",
};

// ── Status sync ────────────────────────────────────────────────────────────
async function syncOnce() {
  const db = loadDb();
  const toSync = db.projects.filter(p => p.containerId && !isBuilding(p.id));

  for (const project of toSync) {
    const dockerState = await dockerStatus(`nexus-app-${project.name}`);
    const expected = DOCKER_TO_PROJECT[dockerState] ?? "stopped";

    if (project.status !== expected) {
      console.log(`[status-sync] ${project.name}: ${project.status} → ${expected} (docker=${dockerState})`);
      await writeDb(db => {
        const p = db.projects.find(p2 => p2.id === project.id);
        if (p) { p.status = expected as typeof p.status; p.updatedAt = Date.now(); }
      });
      emitStatusChange(project.id, expected);
    }
  }
}

// ── Image pruning ──────────────────────────────────────────────────────────
async function pruneImages() {
  const db = loadDb();
  const activeImages = new Set(db.projects.map(p => p.imageTag).filter(Boolean));

  const images: string[] = [];
  await spawnStream(
    "docker",
    ["images", "--format", "{{.Repository}}:{{.Tag}}", "--filter", "reference=nexus/*"],
    line => images.push(line.trim())
  ).catch(() => {});

  let pruned = 0;
  for (const image of images) {
    if (!activeImages.has(image)) {
      await spawnStream("docker", ["rmi", "-f", image], () => {}).catch(() => {});
      pruned++;
    }
  }

  if (pruned > 0) console.log(`[image-prune] Removed ${pruned} unused image(s)`);
}

// ── Boot ───────────────────────────────────────────────────────────────────
export function startStatusSync(intervalMs = 30_000) {
  const firstSync = setTimeout(() => syncOnce().catch(console.error), 10_000);
  const syncInterval = setInterval(() => syncOnce().catch(console.error), intervalMs);

  // Prune once after 5 min, then every hour
  const firstPrune = setTimeout(() => pruneImages().catch(console.error), 5 * 60_000);
  const pruneInterval = setInterval(() => pruneImages().catch(console.error), 60 * 60_000);

  return () => {
    clearTimeout(firstSync); clearInterval(syncInterval);
    clearTimeout(firstPrune); clearInterval(pruneInterval);
  };
}
