import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkBuildAllowed,
  checkProjectQuota,
  containerLimits,
  countRecentBuilds,
  DEFAULT_LIMITS,
  diskFreePercent,
  limitsFromEnv,
  parseMemoryMb,
} from "../src/lib/safeguards.js";

const calm = { activeBuildsForMember: 0, buildsLastHourForMember: 0, hostFreePercent: 60, sandboxUsedPercent: 20 };

test("the defaults are the documented ones", () => {
  assert.deepEqual(
    [DEFAULT_LIMITS.memoryMb, DEFAULT_LIMITS.cpus, DEFAULT_LIMITS.pids, DEFAULT_LIMITS.maxProjects],
    [512, 0.5, 256, 5],
  );
  assert.deepEqual(
    [DEFAULT_LIMITS.maxConcurrentBuilds, DEFAULT_LIMITS.maxBuildsPerHour, DEFAULT_LIMITS.buildTimeoutMs],
    [1, 6, 600_000],
  );
});

test("an operator overrides caps through CAP_* variables and junk is refused", () => {
  assert.equal(limitsFromEnv({}).memoryMb, 512);
  assert.equal(limitsFromEnv({ CAP_MEMORY_MB: "1024", CAP_MAX_PROJECTS: "9" }).memoryMb, 1024);
  assert.equal(limitsFromEnv({ CAP_MAX_PROJECTS: "9" }).maxProjects, 9);
  assert.equal(limitsFromEnv({ CAP_MEMORY_MB: "  " }).memoryMb, 512);
  for (const bad of ["0", "-1", "abc", "Infinity"]) {
    assert.throws(() => limitsFromEnv({ CAP_PIDS: bad }), /CAP_PIDS/, bad);
  }
});

test("memory sizes parse; a bare number means megabytes", () => {
  assert.equal(parseMemoryMb("512m"), 512);
  assert.equal(parseMemoryMb("1g"), 1024);
  assert.equal(parseMemoryMb("256"), 256);
  assert.equal(parseMemoryMb("1.5G"), 1536);
  for (const bad of ["", "abc", "12k", "-5m", "5 m"]) assert.equal(parseMemoryMb(bad), null, bad);
});

test("a project may lower its container limits but never raise them", () => {
  assert.deepEqual(containerLimits({}, DEFAULT_LIMITS), { memory: "512m", cpus: "0.5", pids: 256 });
  assert.deepEqual(containerLimits({ memoryLimit: "256m", cpus: "0.25" }, DEFAULT_LIMITS), {
    memory: "256m",
    cpus: "0.25",
    pids: 256,
  });
  assert.deepEqual(containerLimits({ memoryLimit: "8g", cpus: "16" }, DEFAULT_LIMITS), {
    memory: "512m",
    cpus: "0.5",
    pids: 256,
  });
  assert.deepEqual(containerLimits({ memoryLimit: "nonsense", cpus: "x" }, DEFAULT_LIMITS), {
    memory: "512m",
    cpus: "0.5",
    pids: 256,
  });
});

test("the project quota refuses the project after the last one allowed", () => {
  assert.deepEqual(checkProjectQuota(4, DEFAULT_LIMITS), { ok: true });
  const refused = checkProjectQuota(5, DEFAULT_LIMITS);
  assert.equal(refused.ok, false);
  assert.equal((refused as { code: string }).code, "quota");
});

test("a calm node allows a build", () => {
  assert.deepEqual(checkBuildAllowed(calm, DEFAULT_LIMITS), { ok: true });
});

test("each way a build can be refused has its own code", () => {
  const code = (patch: object) => {
    const verdict = checkBuildAllowed({ ...calm, ...patch }, DEFAULT_LIMITS);
    return verdict.ok ? "ok" : verdict.code;
  };
  assert.equal(code({ hostFreePercent: 14.9 }), "disk");
  assert.equal(code({ hostFreePercent: 15 }), "ok");
  assert.equal(code({ sandboxUsedPercent: 86 }), "disk");
  assert.equal(code({ sandboxUsedPercent: 85 }), "ok");
  assert.equal(code({ activeBuildsForMember: 1 }), "busy");
  assert.equal(code({ buildsLastHourForMember: 6 }), "rate");
  assert.equal(code({ buildsLastHourForMember: 5 }), "ok");
});

test("a full disk is reported before a busy member", () => {
  const verdict = checkBuildAllowed({ ...calm, hostFreePercent: 5, activeBuildsForMember: 3 }, DEFAULT_LIMITS);
  assert.equal(verdict.ok === false && verdict.code, "disk");
});

test("an unmeasured disk does not block builds", () => {
  assert.deepEqual(
    checkBuildAllowed({ ...calm, hostFreePercent: null, sandboxUsedPercent: null }, DEFAULT_LIMITS),
    { ok: true },
  );
});

test("only this member's builds in the last hour count, and rollbacks are free", () => {
  const now = 10_000_000;
  const deployments = [
    { projectId: "p1", triggeredBy: "manual", createdAt: now - 1_000 },
    { projectId: "p1", triggeredBy: "webhook", createdAt: now - 59 * 60_000 },
    { projectId: "p1", triggeredBy: "rollback", createdAt: now - 1_000 },
    { projectId: "p1", triggeredBy: "manual", createdAt: now - 61 * 60_000 },
    { projectId: "other", triggeredBy: "manual", createdAt: now - 1_000 },
  ];
  assert.equal(countRecentBuilds(deployments, new Set(["p1"]), now), 2);
});

test("free disk space is a percentage, and unreadable means unknown", () => {
  assert.equal(diskFreePercent("/x", () => ({ blocks: 1000, bavail: 250 })), 25);
  assert.equal(diskFreePercent("/x", () => ({ blocks: 0, bavail: 0 })), null);
  assert.equal(
    diskFreePercent("/x", () => {
      throw new Error("ENOENT");
    }),
    null,
  );
});
