import assert from "node:assert/strict";
import { test } from "node:test";
import { AUDIT_RETENTION_MS, pruneAudit, recordAudit, type AuditEntry } from "../src/lib/audit.js";

const DAY = 24 * 60 * 60 * 1000;

test("an entry records who did what to what, and when — and nothing about where from", () => {
  const log: AuditEntry[] = [];
  const entry = recordAudit(log, { actor: "ada", action: "project.delete", subject: "prj_1" }, 1_000);
  assert.deepEqual(Object.keys(entry).sort(), ["action", "actor", "at", "id", "subject"]);
  assert.equal(entry.at, 1_000);
  assert.equal(log[0], entry);
});

test("the subject is optional", () => {
  const log: AuditEntry[] = [];
  const entry = recordAudit(log, { actor: "ada", action: "member.grant" }, 1);
  assert.equal("subject" in entry, false);
});

test("newest first", () => {
  const log: AuditEntry[] = [];
  recordAudit(log, { actor: "a", action: "deploy.start" }, 1);
  recordAudit(log, { actor: "b", action: "deploy.cancel" }, 2);
  assert.deepEqual(
    log.map((e) => e.actor),
    ["b", "a"],
  );
});

test("entries older than thirty days are forgotten as new ones arrive", () => {
  const log: AuditEntry[] = [];
  const now = 100 * DAY;
  recordAudit(log, { actor: "old", action: "deploy.start" }, now - 31 * DAY);
  recordAudit(log, { actor: "edge", action: "deploy.start" }, now - 29 * DAY);
  recordAudit(log, { actor: "new", action: "deploy.start" }, now);
  assert.deepEqual(
    log.map((e) => e.actor),
    ["new", "edge"],
  );
});

test("pruning reports how many it dropped and is idempotent", () => {
  const now = 100 * DAY;
  const log: AuditEntry[] = [
    { id: "1", at: now - AUDIT_RETENTION_MS - 1, actor: "x", action: "deploy.start" },
    { id: "2", at: now, actor: "y", action: "deploy.start" },
  ];
  assert.equal(pruneAudit(log, now), 1);
  assert.equal(pruneAudit(log, now), 0);
  assert.equal(log.length, 1);
});

test("the retention is thirty days", () => {
  assert.equal(AUDIT_RETENTION_MS, 30 * DAY);
});
