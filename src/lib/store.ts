/**
 * Encrypted JSON database with async write queue.
 *
 * ALL writes go through `writeDb()` which serialises them through a
 * single promise chain — preventing the race condition where concurrent
 * log-line appends during a build clobber each other.
 */
import fs from "node:fs";
import { config, ensureDataDir } from "./config.js";
import { decryptJson, encryptJson } from "./crypto.js";
import type { Deployment, Project, Session, User } from "../types.js";

export type Database = {
  users: User[];
  projects: Project[];
  deployments: Deployment[];
  sessions: Session[];
};

const emptyDb: Database = {
  users: [],
  projects: [],
  deployments: [],
  sessions: [],
};

// ── Read ───────────────────────────────────────────────────────────────────
export function loadDb(): Database {
  ensureDataDir();
  if (!fs.existsSync(config.dbPath)) return structuredClone(emptyDb);
  const raw = fs.readFileSync(config.dbPath, "utf8");
  if (!raw.trim()) return structuredClone(emptyDb);
  try {
    return decryptJson<Database>(config.appSecret, raw);
  } catch {
    console.error("[store] Failed to decrypt DB — starting fresh");
    return structuredClone(emptyDb);
  }
}

// ── Write queue ────────────────────────────────────────────────────────────
let writeChain: Promise<void> = Promise.resolve();

/**
 * Serialise all writes. Pass a mutator that receives the current DB,
 * modifies it in-place, and returns. The chain guarantees sequential
 * execution even when called from concurrent async contexts.
 */
export function writeDb(mutate: (db: Database) => void): Promise<void> {
  writeChain = writeChain.then(() => {
    const db = loadDb();
    mutate(db);
    flush(db);
  }).catch(err => {
    console.error("[store] Write error:", err);
  });
  return writeChain;
}

/** Synchronous emergency save — use only at startup / seed. */
export function saveDb(db: Database): void {
  flush(db);
}

function flush(db: Database): void {
  ensureDataDir();
  const payload = encryptJson(config.appSecret, db);
  // Atomic write: write to temp file then rename
  const tmp = config.dbPath + ".tmp";
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, config.dbPath);
}

// ── Maintenance: trim old deployments ─────────────────────────────────────
const MAX_DEPLOYMENTS_PER_PROJECT = 50;
const MAX_LOG_LINES = 1_000;

export async function trimDeployments(projectId: string): Promise<void> {
  await writeDb(db => {
    const deps = db.deployments.filter(d => d.projectId === projectId);
    if (deps.length <= MAX_DEPLOYMENTS_PER_PROJECT) return;
    const toDelete = new Set(
      deps
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, deps.length - MAX_DEPLOYMENTS_PER_PROJECT)
        .map(d => d.id)
    );
    db.deployments = db.deployments.filter(d => !toDelete.has(d.id));
  });
}

export function capLogs(logs: string[]): string[] {
  if (logs.length <= MAX_LOG_LINES) return logs;
  const kept = logs.slice(logs.length - MAX_LOG_LINES);
  return [`[nexus] ⚠ Log truncated — showing last ${MAX_LOG_LINES} lines`, ...kept];
}
