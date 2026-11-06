/**
 * The audit log: which account did what, and when.
 *
 * It exists so an operator can answer "who suspended this?" and "who deleted
 * that project?". It deliberately records no address and no user agent, and it
 * forgets after thirty days, the same as sign-in history, because the Charter
 * promises we keep only what we need.
 */
import { newId } from "./auth.js";

export type AuditAction =
  | "member.grant"
  | "member.suspend"
  | "member.reactivate"
  | "project.create"
  | "project.update"
  | "project.delete"
  | "project.suspend"
  | "deploy.start"
  | "deploy.rollback"
  | "deploy.cancel"
  | "project.stop"
  | "project.start"
  | "project.restart"
  | "logs.delete";

export type AuditEntry = {
  id: string;
  at: number;
  /** Nexus-Auth id of the account that acted. */
  actor: string;
  action: AuditAction;
  /** The project or account acted upon, when there is one. */
  subject?: string;
};

export const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Adds an entry to `log` and drops anything older than the retention window. */
export function recordAudit(
  log: AuditEntry[],
  entry: { actor: string; action: AuditAction; subject?: string },
  now: number,
): AuditEntry {
  const full: AuditEntry = {
    id: newId("aud"),
    at: now,
    actor: entry.actor,
    action: entry.action,
    ...(entry.subject !== undefined ? { subject: entry.subject } : {}),
  };
  log.unshift(full);
  pruneAudit(log, now);
  return full;
}

/** In place. Returns how many entries were dropped. */
export function pruneAudit(log: AuditEntry[], now: number): number {
  const keep = log.filter((e) => now - e.at < AUDIT_RETENTION_MS);
  const dropped = log.length - keep.length;
  if (dropped > 0) log.splice(0, log.length, ...keep);
  return dropped;
}
