/**
 * Background status sync — polls Docker every 30s and corrects project
 * status in the DB when reality diverges from what we have stored.
 * Handles: container crashes, manual docker stops, host reboots.
 */
import { loadDb, saveDb } from "./store.js";
import { dockerStatus } from "./docker.js";

const DOCKER_TO_PROJECT: Record<string, string> = {
  running: "live",
  exited:  "stopped",
  paused:  "stopped",
  dead:    "failed",
  missing: "stopped",
};

async function syncOnce() {
  const db = loadDb();
  let dirty = false;

  for (const project of db.projects) {
    // Only check projects we actually have a container for
    if (!project.containerId || project.status === "building") continue;

    const dockerState = await dockerStatus(`nexus-app-${project.name}`);
    const expected = DOCKER_TO_PROJECT[dockerState] ?? "stopped";

    if (project.status !== expected) {
      console.log(`[status-sync] ${project.name}: ${project.status} → ${expected} (docker=${dockerState})`);
      project.status = expected as typeof project.status;
      project.updatedAt = Date.now();
      dirty = true;
    }
  }

  if (dirty) saveDb(db);
}

export function startStatusSync(intervalMs = 30_000) {
  // Initial sync after 10s (let server fully boot first)
  const first = setTimeout(() => {
    syncOnce().catch(err => console.error("[status-sync] error:", err.message));
  }, 10_000);

  const interval = setInterval(() => {
    syncOnce().catch(err => console.error("[status-sync] error:", err.message));
  }, intervalMs);

  return () => { clearTimeout(first); clearInterval(interval); };
}
