import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { emitStatusChange } from "../src/lib/events.js";
import { addDeployment, addProject, resetDb, startHarness, store } from "./support/app-harness.js";

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});
beforeEach(async () => {
  resetDb();
  h.ops.calls.length = 0;
  h.pipeline.deploys.length = 0;
  h.pipeline.rollbacks.length = 0;
  h.pipeline.cancelled.length = 0;
  h.pipeline.building.clear();
  h.pipeline.verdict = { ok: true };
  h.publisher.unpublished.length = 0;
  // The founder arrives first (becoming owner) and lets Ada and Bob in.
  await h.call("GET", "/api/projects", { token: "t-boss" });
  await h.call("POST", "/api/admin/members", { token: "t-boss", body: { authUserId: "ada" } });
  await h.call("POST", "/api/admin/members", { token: "t-boss", body: { authUserId: "bob" } });
});

test("deploy starts a build for the owner, records who did it, and returns the deployment", async () => {
  const p = addProject({ ownerId: "ada" });
  const r = await h.call("POST", `/api/projects/${p.id}/deploy`, {
    token: "t-ada",
    body: { commitSha: "feedface" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.deployment.commitSha, "feedface");
  assert.deepEqual(
    h.pipeline.deploys.map((d) => d.projectId),
    [p.id],
  );
  assert.ok(
    store
      .loadDb()
      .audit.some((e) => e.action === "deploy.start" && e.actor === "ada" && e.subject === p.id),
  );
});

test("a commit label that is not plain text is replaced, so it cannot reach logs or webhooks", async () => {
  const p = addProject({ ownerId: "ada" });
  const r = await h.call("POST", `/api/projects/${p.id}/deploy`, {
    token: "t-ada",
    body: { commitSha: "x; rm -rf /" },
  });
  assert.equal(r.body.deployment.commitSha, "manual");
});

test("someone else's project cannot be deployed, and nothing starts", async () => {
  const p = addProject({ ownerId: "bob" });
  const r = await h.call("POST", `/api/projects/${p.id}/deploy`, { token: "t-ada" });
  assert.equal(r.status, 404);
  assert.equal(h.pipeline.deploys.length, 0);
});

test("a build already running is a 409, and each safeguard refusal has its own status", async () => {
  const p = addProject({ ownerId: "ada" });
  h.pipeline.building.add(p.id);
  assert.equal(
    (await h.call("POST", `/api/projects/${p.id}/deploy`, { token: "t-ada" })).status,
    409,
  );
  h.pipeline.building.clear();

  const cases = [
    ["disk", 503],
    ["busy", 409],
    ["rate", 429],
    ["quota", 403],
  ] as const;
  for (const [code, status] of cases) {
    h.pipeline.verdict = { ok: false, code, message: `refused: ${code}` };
    const r = await h.call("POST", `/api/projects/${p.id}/deploy`, { token: "t-ada" });
    assert.equal(r.status, status, code);
    assert.equal(r.body.code, code);
    assert.equal(r.body.error, `refused: ${code}`);
  }
  assert.equal(h.pipeline.deploys.length, 0, "no refused request started a build");
});

test("rollback re-runs the recorded image as a new deployment", async () => {
  const p = addProject({ ownerId: "ada", status: "live", containerName: "nexus-app-demo-new" });
  const old = addDeployment({
    projectId: p.id,
    imageTag: "nexus/demo:old",
    commitSha: "0123456789abcdef",
  });
  const r = await h.call("POST", `/api/deployments/${old.id}/rollback`, { token: "t-ada" });
  assert.equal(r.status, 200);
  assert.deepEqual(
    h.pipeline.rollbacks.map((x) => x.imageRef),
    ["nexus/demo:old"],
  );
  assert.equal(r.body.deployment.triggeredBy, "rollback");
  assert.equal(
    store.loadDb().deployments.find((d) => d.id === r.body.deployment.id)?.imageTag,
    "nexus/demo:old",
  );
});

test("rollback refuses a deployment with no image, a busy project, and another member's", async () => {
  const p = addProject({ ownerId: "ada" });
  const noImage = addDeployment({ projectId: p.id, imageTag: "" });
  assert.equal(
    (await h.call("POST", `/api/deployments/${noImage.id}/rollback`, { token: "t-ada" })).status,
    400,
  );
  const withImage = addDeployment({ projectId: p.id, imageTag: "nexus/demo:old" });
  h.pipeline.building.add(p.id);
  assert.equal(
    (await h.call("POST", `/api/deployments/${withImage.id}/rollback`, { token: "t-ada" })).status,
    409,
  );
  h.pipeline.building.clear();
  assert.equal(
    (await h.call("POST", `/api/deployments/${withImage.id}/rollback`, { token: "t-bob" })).status,
    404,
  );
  assert.equal(h.pipeline.rollbacks.length, 0);
});

test("cancel stops a running build; one that is not running cannot be cancelled", async () => {
  const p = addProject({ ownerId: "ada" });
  const running = addDeployment({ projectId: p.id, status: "building" });
  const done = addDeployment({ projectId: p.id, status: "live" });
  const ok = await h.call("POST", `/api/deployments/${running.id}/cancel`, { token: "t-ada" });
  assert.deepEqual(ok.body, { ok: true, cancelled: true });
  assert.deepEqual(h.pipeline.cancelled, [running.id]);
  assert.equal(
    (await h.call("POST", `/api/deployments/${done.id}/cancel`, { token: "t-ada" })).status,
    400,
  );
  assert.equal(
    (await h.call("POST", `/api/deployments/${running.id}/cancel`, { token: "t-bob" })).status,
    404,
  );
});

test("if the build can no longer be killed, cancel still marks it cancelled", async () => {
  const p = addProject({ ownerId: "ada" });
  const running = addDeployment({ projectId: p.id, status: "building" });
  h.pipeline.cancellable = false;
  const r = await h.call("POST", `/api/deployments/${running.id}/cancel`, { token: "t-ada" });
  h.pipeline.cancellable = true;
  assert.equal(r.body.cancelled, false);
  assert.equal(store.loadDb().deployments.find((d) => d.id === running.id)?.status, "cancelled");
});

test("stop, start and restart act on the container serving now, falling back to the old fixed name", async () => {
  const modern = addProject({
    ownerId: "ada",
    name: "modern",
    containerName: "nexus-app-modern-ab12cd34",
    status: "live",
  });
  const legacy = addProject({ ownerId: "ada", name: "legacy", containerId: "abc", status: "live" });
  await h.call("POST", `/api/projects/${modern.id}/stop`, { token: "t-ada" });
  await h.call("POST", `/api/projects/${legacy.id}/restart`, { token: "t-ada" });
  await h.call("POST", `/api/projects/${modern.id}/start`, { token: "t-ada" });
  assert.deepEqual(h.ops.calls, [
    "stop:nexus-app-modern-ab12cd34",
    "restart:nexus-app-legacy",
    "start:nexus-app-modern-ab12cd34",
  ]);
  assert.equal(store.loadDb().projects.find((p) => p.id === modern.id)?.status, "live");
});

test("restart with nothing to restart is a 400, and other members' containers are untouchable", async () => {
  const never = addProject({ ownerId: "ada" });
  assert.equal(
    (await h.call("POST", `/api/projects/${never.id}/restart`, { token: "t-ada" })).status,
    400,
  );
  const bobs = addProject({ ownerId: "bob", containerName: "nexus-app-bobs-x" });
  for (const action of ["stop", "start", "restart"]) {
    assert.equal(
      (await h.call("POST", `/api/projects/${bobs.id}/${action}`, { token: "t-ada" })).status,
      404,
      action,
    );
  }
  assert.deepEqual(h.ops.calls, []);
});

test("health reports the container's state and corrects a project that says live but is not", async () => {
  const p = addProject({ ownerId: "ada", status: "live", containerName: "nexus-app-demo-x" });
  h.ops.statusValue = "exited";
  const r = await h.call("GET", `/api/projects/${p.id}/health`, { token: "t-ada" });
  h.ops.statusValue = "running";
  assert.deepEqual(r.body, { healthy: false, dockerStatus: "exited" });
  assert.equal(store.loadDb().projects.find((x) => x.id === p.id)?.status, "stopped");
});

test("stats only for a live project, and only for its owner", async () => {
  const live = addProject({ ownerId: "ada", status: "live", containerName: "nexus-app-demo-x" });
  const idle = addProject({ ownerId: "ada", name: "idle", status: "stopped" });
  assert.equal(
    (await h.call("GET", `/api/projects/${live.id}/stats`, { token: "t-ada" })).body.stats.cpu,
    "1%",
  );
  assert.equal(
    (await h.call("GET", `/api/projects/${idle.id}/stats`, { token: "t-ada" })).body.stats,
    null,
  );
  assert.equal(
    (await h.call("GET", `/api/projects/${live.id}/stats`, { token: "t-bob" })).status,
    404,
  );
});

test("a build's log is readable by its owner, deletable by its owner, and nobody else", async () => {
  const p = addProject({ ownerId: "ada" });
  const dep = addDeployment({ projectId: p.id, logs: ["line one", "line two"], status: "live" });
  assert.deepEqual(
    (await h.call("GET", `/api/deployments/${dep.id}/logs`, { token: "t-ada" })).body.logs,
    ["line one", "line two"],
  );
  assert.equal(
    (await h.call("GET", `/api/deployments/${dep.id}/logs`, { token: "t-bob" })).status,
    404,
  );
  assert.equal(
    (await h.call("DELETE", `/api/deployments/${dep.id}/logs`, { token: "t-bob" })).status,
    404,
  );
  assert.equal(
    (await h.call("DELETE", `/api/deployments/${dep.id}/logs`, { token: "t-ada" })).status,
    200,
  );
  assert.deepEqual(store.loadDb().deployments.find((d) => d.id === dep.id)?.logs, [
    "[nexus] Log deleted by its owner",
  ]);
});

test("a build in progress cannot have its log deleted", async () => {
  const p = addProject({ ownerId: "ada" });
  const dep = addDeployment({ projectId: p.id, status: "building" });
  assert.equal(
    (await h.call("DELETE", `/api/deployments/${dep.id}/logs`, { token: "t-ada" })).status,
    409,
  );
});

test("activity shows only the caller's own deployments, operators' everything", async () => {
  const mine = addProject({ ownerId: "ada", name: "mine" });
  const theirs = addProject({ ownerId: "bob", name: "theirs" });
  addDeployment({ projectId: mine.id });
  addDeployment({ projectId: theirs.id });
  const ada = (await h.call("GET", "/api/activity", { token: "t-ada" })).body.activity;
  assert.deepEqual(
    ada.map((a: { projectName: string }) => a.projectName),
    ["mine"],
  );
  const boss = (await h.call("GET", "/api/activity", { token: "t-boss" })).body.activity;
  assert.equal(boss.length, 2);
});

test("the live status stream carries a member's own projects and nobody else's", async () => {
  const mine = addProject({ ownerId: "ada", name: "mine" });
  const theirs = addProject({ ownerId: "bob", name: "theirs" });
  const abort = new AbortController();
  const response = await fetch(`${h.url}/api/events?token=t-ada`, { signal: abort.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const read = async () => {
    const { value } = await reader.read();
    seen += decoder.decode(value);
  };
  await read();
  assert.match(seen, /connected/);
  emitStatusChange(theirs.id, "building");
  emitStatusChange(mine.id, "live");
  while (!seen.includes(mine.id)) await read();
  abort.abort();
  assert.ok(seen.includes(mine.id));
  assert.ok(!seen.includes(theirs.id), "another member's project never appears");
});

test("an export has everything needed to recreate a project, and no credentials", async () => {
  const p = addProject({
    ownerId: "ada",
    name: "exported",
    source: { type: "git", repo: "ada/app", branch: "main", token: "ghp_exportsecret1" },
    env: { A: "1" },
    healthPath: "/up",
    port: 8080,
    webhookSecret: "whsec_secret_value",
  });
  const r = await h.call("GET", `/api/projects/${p.id}/export`, { token: "t-ada" });
  assert.equal(r.status, 200);
  assert.equal(r.body.format, "nexus-deploy-project/1");
  assert.deepEqual(r.body.project.source, { type: "git", repo: "ada/app", branch: "main" });
  assert.deepEqual(r.body.project.env, { A: "1" });
  assert.equal(r.body.project.healthPath, "/up");
  assert.equal(r.body.project.port, 8080);
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes("ghp_exportsecret1") && !text.includes("whsec_secret_value"));
  assert.equal(
    (await h.call("GET", `/api/projects/${p.id}/export`, { token: "t-bob" })).status,
    404,
  );
});

test("deleting a project removes its containers, route, volume, images, records and name", async () => {
  const p = addProject({
    ownerId: "ada",
    name: "doomed",
    containerName: "nexus-app-doomed-ab12cd34",
    imageTag: "nexus/doomed:ab12cd34",
    previousImageTag: "nexus/doomed:00000000",
  });
  addDeployment({ projectId: p.id, imageTag: "nexus/doomed:11111111" });
  const r = await h.call("DELETE", `/api/projects/${p.id}`, { token: "t-ada" });
  assert.equal(r.status, 200);

  assert.deepEqual(h.ops.calls.filter((c) => c.startsWith("remove:")).sort(), [
    "remove:nexus-app-doomed",
    "remove:nexus-app-doomed-ab12cd34",
  ]);
  assert.ok(h.ops.calls.includes("removeVolume:nexus-vol-doomed"));
  assert.deepEqual(h.ops.calls.filter((c) => c.startsWith("removeImage:")).sort(), [
    "removeImage:nexus/doomed:00000000",
    "removeImage:nexus/doomed:11111111",
    "removeImage:nexus/doomed:ab12cd34",
  ]);
  const containersFirst = h.ops.calls.findIndex((c) => c.startsWith("removeImage:"));
  assert.ok(
    h.ops.calls.findIndex((c) => c.startsWith("remove:")) < containersFirst,
    "containers go before their images",
  );
  assert.deepEqual(h.publisher.unpublished, ["doomed"]);
  const db = store.loadDb();
  assert.equal(db.projects.length, 0);
  assert.equal(db.deployments.length, 0);
  assert.ok(db.audit.some((e) => e.action === "project.delete"));
});

test("a project cannot be deleted mid-build, or by someone else", async () => {
  const p = addProject({ ownerId: "ada" });
  h.pipeline.building.add(p.id);
  assert.equal((await h.call("DELETE", `/api/projects/${p.id}`, { token: "t-ada" })).status, 409);
  h.pipeline.building.clear();
  assert.equal((await h.call("DELETE", `/api/projects/${p.id}`, { token: "t-bob" })).status, 404);
  assert.equal(store.loadDb().projects.length, 1);
  assert.deepEqual(h.ops.calls, []);
});
