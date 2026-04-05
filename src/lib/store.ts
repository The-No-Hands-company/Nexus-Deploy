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

export function loadDb(): Database {
  ensureDataDir();
  if (!fs.existsSync(config.dbPath)) return emptyDb;
  const raw = fs.readFileSync(config.dbPath, "utf8");
  if (!raw) return emptyDb;
  try {
    return decryptJson<Database>(config.appSecret, raw);
  } catch {
    return emptyDb;
  }
}

export function saveDb(db: Database) {
  ensureDataDir();
  const payload = encryptJson(config.appSecret, db);
  fs.writeFileSync(config.dbPath, payload, "utf8");
}
