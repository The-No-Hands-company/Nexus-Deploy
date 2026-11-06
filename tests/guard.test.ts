import assert from "node:assert/strict";
import { test } from "node:test";
import { containerNameOf } from "../src/lib/containers.js";
import { type GuardContext, evaluateBuildGuard } from "../src/lib/guard.js";
import { DEFAULT_LIMITS } from "../src/lib/safeguards.js";

const now = 50_000_000;
const calm: GuardContext = {
  isBuilding: () => false,
  hostFreePercent: 60,
  sandboxUsedPercent: 10,
  now,
};
const data = {
  projects: [
    { id: "a1", ownerId: "ada" },
    { id: "a2", ownerId: "ada" },
    { id: "b1", ownerId: "bob" },
    { id: "old" },
  ],
  deployments: [] as Array<{ projectId: string; triggeredBy: string; createdAt: number }>,
};
const code = (v: ReturnType<typeof evaluateBuildGuard>) => (v.ok ? "ok" : v.code);

test("a calm node lets a member build", () => {
  assert.equal(code(evaluateBuildGuard(data, { ownerId: "ada" }, calm, DEFAULT_LIMITS)), "ok");
});

test("a build running in another of the member's projects counts against them", () => {
  const ctx = { ...calm, isBuilding: (id: string) => id === "a2" };
  assert.equal(code(evaluateBuildGuard(data, { ownerId: "ada" }, ctx, DEFAULT_LIMITS)), "busy");
});

test("someone else's running build does not", () => {
  const ctx = { ...calm, isBuilding: (id: string) => id === "b1" };
  assert.equal(code(evaluateBuildGuard(data, { ownerId: "ada" }, ctx, DEFAULT_LIMITS)), "ok");
});

test("builds in the last hour across all of a member's projects are rate limited", () => {
  const recent = Array.from({ length: 6 }, (_, i) => ({
    projectId: i % 2 ? "a1" : "a2",
    triggeredBy: "manual",
    createdAt: now - 1_000 * (i + 1),
  }));
  const verdict = evaluateBuildGuard(
    { ...data, deployments: recent },
    { ownerId: "ada" },
    calm,
    DEFAULT_LIMITS,
  );
  assert.equal(code(verdict), "rate");
  assert.equal(
    code(
      evaluateBuildGuard(
        { ...data, deployments: recent },
        { ownerId: "bob" },
        calm,
        DEFAULT_LIMITS,
      ),
    ),
    "ok",
  );
});

test("a low disk pauses everyone's builds", () => {
  const ctx = { ...calm, hostFreePercent: 9 };
  assert.equal(code(evaluateBuildGuard(data, { ownerId: "bob" }, ctx, DEFAULT_LIMITS)), "disk");
});

test("a project with no owner is not grouped with other ownerless projects", () => {
  const ctx = { ...calm, isBuilding: (id: string) => id === "old" };
  assert.equal(code(evaluateBuildGuard(data, {}, ctx, DEFAULT_LIMITS)), "ok");
});

test("the serving container is named per release, with the old fixed name as a fallback", () => {
  assert.equal(
    containerNameOf({ name: "demo", containerName: "nexus-app-demo-abcd1234" }),
    "nexus-app-demo-abcd1234",
  );
  assert.equal(containerNameOf({ name: "demo" }), "nexus-app-demo");
});
