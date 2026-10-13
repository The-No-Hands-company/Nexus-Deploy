import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptsStatus, waitForHealthy } from "../src/lib/health.js";

// A fake clock so the deadline logic is exercised without real waiting.
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

test("a declared health path must answer 2xx; an undeclared one only must not error", () => {
  assert.equal(acceptsStatus(200, true), true);
  assert.equal(acceptsStatus(404, true), false);
  assert.equal(acceptsStatus(503, true), false);
  assert.equal(acceptsStatus(404, false), true);
  assert.equal(acceptsStatus(302, false), true);
  assert.equal(acceptsStatus(500, false), false);
});

test("passes once the probe answers, even after early connection failures", async () => {
  const answers = [null, null, 200];
  const result = await waitForHealthy({
    probe: async () => answers.shift() ?? 200,
    isRunning: async () => true,
    requireOk: true, timeoutMs: 10_000, intervalMs: 500, ...clock(),
  });
  assert.deepEqual(result, { ok: true });
});

test("fails at the deadline when the app never answers", async () => {
  const result = await waitForHealthy({
    probe: async () => null,
    isRunning: async () => true,
    requireOk: true, timeoutMs: 3_000, intervalMs: 500, ...clock(),
  });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /did not answer/);
});

test("fails at the deadline when the app answers but unhealthily", async () => {
  const result = await waitForHealthy({
    probe: async () => 503,
    isRunning: async () => true,
    requireOk: true, timeoutMs: 3_000, intervalMs: 500, ...clock(),
  });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /503/);
});

test("fails fast when the container has exited instead of waiting out the deadline", async () => {
  const c = clock();
  let probes = 0;
  const result = await waitForHealthy({
    probe: async () => { probes++; return null; },
    isRunning: async () => false,
    requireOk: false, timeoutMs: 60_000, intervalMs: 500, ...c,
  });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /exited/);
  assert.ok(c.now() < 60_000, "must not wait for the full deadline");
  assert.ok(probes <= 1);
});
