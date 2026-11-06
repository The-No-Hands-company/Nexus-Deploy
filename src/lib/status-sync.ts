/**
 * Background status sync — polls Docker every 30s and corrects project
 * status in the DB when reality diverges from what we have stored.
 * Also prunes old nexus Docker images once per hour.
 */
import { pruneAudit } from "./audit.js";
import { isBuilding } from "./build.js";
import { containerNameOf } from "./containers.js";
import { dockerListImages, dockerRemoveImage, dockerStatus } from "./docker.js";
import { emitStatusChange } from "./events.js";
import { imagesToPrune, keepRefs } from "./prune.js";
import { loadDb, writeDb } from "./store.js";

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
    const dockerState = await dockerStatus(containerNameOf(project));
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

// ── Housekeeping ───────────────────────────────────────────────────────────
// Images nothing needs, and audit entries past their thirty days. Docker itself
// refuses to remove an image a container still uses, so this never forces.
async function housekeeping() {
  const db = loadDb();
  const doomed = imagesToPrune(await dockerListImages(), keepRefs(db));
  let pruned = 0;
  for (const ref of doomed) if (await dockerRemoveImage(ref)) pruned++;
  if (pruned > 0) console.log(`[image-prune] Removed ${pruned} unused image(s)`);
  await writeDb((d) => {
    pruneAudit(d.audit, Date.now());
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────
export function startStatusSync(intervalMs = 30_000) {
  const firstSync = setTimeout(() => syncOnce().catch(console.error), 10_000);
  const syncInterval = setInterval(() => syncOnce().catch(console.error), intervalMs);

  // Prune once after 5 min, then every hour
  const firstPrune = setTimeout(() => housekeeping().catch(console.error), 5 * 60_000);
  const pruneInterval = setInterval(() => housekeeping().catch(console.error), 60 * 60_000);

  return () => {
    clearTimeout(firstSync); clearInterval(syncInterval);
    clearTimeout(firstPrune); clearInterval(pruneInterval);
  };
}
