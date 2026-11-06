import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { addProject, resetDb, startHarness, store } from "./support/app-harness.js";

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});

const SECRET = "whsec_test_secret";
const sign = (body: string, secret = SECRET) =>
  `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
const push = (project: { id: string }, body: object, headers: Record<string, string> = {}) => {
  const raw = JSON.stringify(body);
  return h.call("POST", `/api/webhooks/github/${project.id}`, {
    rawBody: raw,
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "push",
      "X-Hub-Signature-256": sign(raw),
      ...headers,
    },
  });
};

beforeEach(() => {
  resetDb();
  h.pipeline.deploys.length = 0;
  h.pipeline.building.clear();
  h.pipeline.verdict = { ok: true };
});

test("a correctly signed push to the tracked branch starts a build", async () => {
  const p = addProject({});
  const r = await push(p, { ref: "refs/heads/main", after: "deadbeefcafe" });
  assert.equal(r.status, 200);
  assert.ok(r.body.deploymentId);
  assert.deepEqual(
    h.pipeline.deploys.map((d) => d.projectId),
    [p.id],
  );
  assert.equal(store.loadDb().deployments[0]?.triggeredBy, "webhook");
  assert.equal(store.loadDb().deployments[0]?.commitSha, "deadbeefcafe");
});

test("a request with no signature is refused, however it is dressed up", async () => {
  const p = addProject({});
  const raw = JSON.stringify({ ref: "refs/heads/main" });
  const r = await h.call("POST", `/api/webhooks/github/${p.id}`, {
    rawBody: raw,
    headers: { "Content-Type": "application/json", "X-GitHub-Event": "push" },
  });
  assert.equal(r.status, 401);
  assert.equal(h.pipeline.deploys.length, 0);
});

test("a wrong, truncated or differently-keyed signature is refused", async () => {
  const p = addProject({});
  const raw = JSON.stringify({ ref: "refs/heads/main" });
  for (const bad of [
    sign(raw, "another-secret"),
    sign(raw).slice(0, -4),
    "sha256=",
    "nonsense",
    sign("different body"),
  ]) {
    const r = await push(p, { ref: "refs/heads/main" }, { "X-Hub-Signature-256": bad });
    assert.equal(r.status, 401, bad);
  }
  assert.equal(h.pipeline.deploys.length, 0);
});

test("a project with no webhook secret refuses all webhooks", async () => {
  const p = addProject({ webhookSecret: "" });
  assert.equal((await push(p, { ref: "refs/heads/main" })).status, 403);
});

test("an unknown project is a 404", async () => {
  const r = await push({ id: "prj_nope" }, { ref: "refs/heads/main" });
  assert.equal(r.status, 404);
});

test("GitHub's ping is answered and builds nothing", async () => {
  const p = addProject({});
  const r = await push(p, { zen: "hello" }, { "X-GitHub-Event": "ping" });
  assert.deepEqual(r.body, { ok: true, pong: true });
  assert.equal(h.pipeline.deploys.length, 0);
});

test("events other than push are skipped", async () => {
  const p = addProject({});
  const r = await push(p, { action: "opened" }, { "X-GitHub-Event": "issues" });
  assert.match(r.body.skipped, /event issues/);
  assert.equal(h.pipeline.deploys.length, 0);
});

test("a push to another branch, or with auto-deploy off, or mid-build, is skipped", async () => {
  const other = await push(addProject({}), { ref: "refs/heads/feature" });
  assert.match(other.body.skipped, /branch feature/);

  const off = await push(addProject({ autoDeployEnabled: false }), { ref: "refs/heads/main" });
  assert.match(off.body.skipped, /auto-deploy disabled/);

  const busy = addProject({});
  h.pipeline.building.add(busy.id);
  assert.match((await push(busy, { ref: "refs/heads/main" })).body.skipped, /build in progress/);
  assert.equal(h.pipeline.deploys.length, 0);
});

test("a push counts against the safeguards, so a push loop cannot bypass them", async () => {
  const p = addProject({});
  h.pipeline.verdict = { ok: false, code: "rate", message: "too many builds" };
  const r = await push(p, { ref: "refs/heads/main" });
  assert.equal(r.status, 200);
  assert.equal(r.body.skipped, "too many builds");
  assert.equal(h.pipeline.deploys.length, 0);
});

test("a suspended member's projects stop building on push", async () => {
  const p = addProject({ ownerId: "ada" });
  const db = store.loadDb();
  db.members.push({
    authUserId: "ada",
    role: "member",
    status: "suspended",
    grantedBy: "boss",
    grantedAt: 1,
  });
  store.saveDb(db);
  const r = await push(p, { ref: "refs/heads/main" });
  assert.equal(r.body.skipped, "owner suspended");
  assert.equal(h.pipeline.deploys.length, 0);
});

test("an image project has no use for a push webhook", async () => {
  const p = addProject({ repo: "nginx", branch: "", source: { type: "image", image: "nginx" } });
  assert.equal((await push(p, { ref: "refs/heads/main" })).status, 400);
});

test("a signed body that is not JSON is a 400", async () => {
  const p = addProject({});
  const raw = "this is not json";
  const r = await h.call("POST", `/api/webhooks/github/${p.id}`, {
    rawBody: raw,
    headers: {
      "X-GitHub-Event": "push",
      "X-Hub-Signature-256": sign(raw),
      "Content-Type": "application/json",
    },
  });
  assert.equal(r.status, 400);
});
