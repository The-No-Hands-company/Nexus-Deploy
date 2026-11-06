import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { DEFAULT_LIMITS } from "../src/lib/safeguards.js";
import { resetDb, startHarness, store } from "./support/app-harness.js";

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});
beforeEach(() => resetDb());
afterEach(() => {
  h.deps.takenElsewhere = async () => false;
});

/** The founder arrives first, becoming owner, then lets Ada and Bob in. */
async function seedMembers() {
  await h.call("GET", "/api/projects", { token: "t-boss" });
  await h.call("POST", "/api/admin/members", { token: "t-boss", body: { authUserId: "ada", label: "Ada" } });
  await h.call("POST", "/api/admin/members", { token: "t-boss", body: { authUserId: "bob" } });
}

async function create(token: string, body: object) {
  return h.call("POST", "/api/projects", { token, body });
}

test("health is public and says nothing about anyone", async () => {
  const r = await h.call("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["name", "ok", "time", "version"]);
});

test("no credentials is a 401 for an API client and a trip to sign-in for a browser", async () => {
  assert.equal((await h.call("GET", "/api/projects")).status, 401);
  const nav = await fetch(`${h.url}/api/projects`, { headers: { Accept: "text/html" }, redirect: "manual" });
  assert.equal(nav.status, 302);
  assert.match(nav.headers.get("location") ?? "", /\/login\?redirect=/);
});

test("a bad token is refused, and an unreachable identity service is a 503, not a 401", async () => {
  assert.equal((await h.call("GET", "/api/projects", { token: "nope" })).status, 401);
  const down = await h.call("GET", "/api/projects", { token: "t-down" });
  assert.equal(down.status, 503);
});

test("an account nobody let in cannot use Deploy, and is told who to ask", async () => {
  const r = await h.call("GET", "/api/projects", { token: "t-ada" });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "not_a_member");
  assert.match(r.body.hint, /operator/);
  const me = await h.call("GET", "/api/me", { token: "t-ada" });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.access, { member: false, reason: "not_a_member" });
});

test("the first founder to arrive becomes the owner and adopts projects from before ownership", async () => {
  store.saveDb({
    users: [],
    projects: [{ id: "prj_old", name: "legacy", repo: "o/r", branch: "main" } as never],
    deployments: [],
    sessions: [],
    members: [],
    audit: [],
  });
  assert.equal((await h.call("GET", "/api/projects", { token: "t-boss" })).status, 200);
  const db = store.loadDb();
  assert.deepEqual(db.members.map((m) => [m.authUserId, m.role]), [["boss", "owner"]]);
  assert.equal(db.projects[0]?.ownerId, "boss");
  await h.call("GET", "/api/projects", { token: "t-boss" });
  assert.equal(store.loadDb().members.length, 1, "arriving again seeds nothing");
});

test("an admin can use Deploy as an operator but cannot claim an empty node", async () => {
  const r = await h.call("GET", "/api/projects", { token: "t-admin" });
  assert.equal(r.status, 200);
  assert.equal(store.loadDb().members.length, 0);
});

test("an operator lets an account in, and only then can it create projects", async () => {
  await seedMembers();
  const r = await create("t-ada", { name: "Ada Blog", repo: "ada/blog" });
  assert.equal(r.status, 201);
  assert.equal(r.body.project.name, "ada-blog");
  assert.equal(r.body.project.ownerId, "ada");
  assert.equal(r.body.project.status, "idle");
  assert.ok(r.body.project.webhookSecret);
});

test("only operators manage members", async () => {
  await seedMembers();
  assert.equal((await h.call("GET", "/api/admin/members", { token: "t-ada" })).status, 403);
  assert.equal((await h.call("POST", "/api/admin/members", { token: "t-ada", body: { authUserId: "cy" } })).status, 403);
  assert.equal((await h.call("GET", "/api/admin/members", { token: "t-boss" })).body.members.length, 3);
});

test("member input is validated: ids and labels", async () => {
  await seedMembers();
  for (const body of [{}, { authUserId: "" }, { authUserId: "a b" }, { authUserId: "x".repeat(129) }, { authUserId: "ok", label: 5 }]) {
    assert.equal((await h.call("POST", "/api/admin/members", { token: "t-boss", body })).status, 400, JSON.stringify(body));
  }
});

test("a member sees and changes only their own projects; to anyone else they do not exist", async () => {
  await seedMembers();
  const mine = (await create("t-ada", { name: "mine", repo: "ada/mine" })).body.project;
  const theirs = (await create("t-bob", { name: "theirs", repo: "bob/theirs" })).body.project;

  const list = (await h.call("GET", "/api/projects", { token: "t-ada" })).body.projects;
  assert.deepEqual(list.map((p: { id: string }) => p.id), [mine.id]);

  for (const [method, route, body] of [
    ["GET", `/api/projects/${theirs.id}`, undefined],
    ["PUT", `/api/projects/${theirs.id}`, { branch: "x" }],
    ["PUT", `/api/projects/${theirs.id}/env`, { env: { A: "1" } }],
    ["POST", `/api/projects/${theirs.id}/regen-webhook-secret`, undefined],
  ] as const) {
    const r = await h.call(method, route, { token: "t-ada", ...(body ? { body } : {}) });
    assert.equal(r.status, 404, `${method} ${route}`);
  }
  assert.equal(store.loadDb().projects.find((p) => p.id === theirs.id)?.branch, "main", "nothing changed");
});

test("operators see every project", async () => {
  await seedMembers();
  await create("t-ada", { name: "one", repo: "ada/one" });
  await create("t-bob", { name: "two", repo: "bob/two" });
  const list = (await h.call("GET", "/api/projects", { token: "t-boss" })).body.projects;
  assert.equal(list.length, 2);
  const id = list[0].id;
  assert.equal((await h.call("GET", `/api/projects/${id}`, { token: "t-admin" })).status, 200);
});

test("a suspended member is shut out, and an owner cannot be suspended", async () => {
  await seedMembers();
  const suspend = await h.call("PATCH", "/api/admin/members/ada", { token: "t-boss", body: { status: "suspended" } });
  assert.equal(suspend.status, 200);
  const r = await h.call("GET", "/api/projects", { token: "t-ada" });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "suspended");
  await h.call("PATCH", "/api/admin/members/ada", { token: "t-boss", body: { status: "active" } });
  assert.equal((await h.call("GET", "/api/projects", { token: "t-ada" })).status, 200);

  assert.equal((await h.call("PATCH", "/api/admin/members/boss", { token: "t-admin", body: { status: "suspended" } })).status, 409);
  assert.equal((await h.call("PATCH", "/api/admin/members/ghost", { token: "t-boss", body: { status: "active" } })).status, 404);
  assert.equal((await h.call("PATCH", "/api/admin/members/ada", { token: "t-boss", body: { status: "banned" } })).status, 400);
});

test("names: reserved, malformed, duplicate and unverifiable ones are refused with the right status", async () => {
  await seedMembers();
  assert.equal((await create("t-ada", { name: "deploy", repo: "o/r" })).status, 400);
  assert.equal((await create("t-ada", { name: "??", repo: "o/r" })).status, 400);
  assert.equal((await create("t-ada", { name: "web", repo: "o/r" })).status, 201);
  const dup = await create("t-bob", { name: "web", repo: "o/r" });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "taken");

  h.deps.takenElsewhere = async (slug) => slug === "hostedsite";
  assert.equal((await create("t-ada", { name: "hostedsite", repo: "o/r" })).status, 409);

  h.deps.takenElsewhere = async () => {
    throw new Error("hosting is unreachable");
  };
  const unverified = await create("t-ada", { name: "anything", repo: "o/r" });
  assert.equal(unverified.status, 503);
  assert.equal(unverified.body.code, "unverified");
});

test("the project quota stops the sixth project, not the fifth", async () => {
  await seedMembers();
  for (let i = 1; i <= DEFAULT_LIMITS.maxProjects; i++) {
    assert.equal((await create("t-ada", { name: `app${i}x`, repo: "o/r" })).status, 201, `project ${i}`);
  }
  const sixth = await create("t-ada", { name: "onetoomany", repo: "o/r" });
  assert.equal(sixth.status, 403);
  assert.equal(sixth.body.code, "quota");
  assert.equal((await create("t-bob", { name: "bobsfirst", repo: "o/r" })).status, 201, "another member is unaffected");
});

test("bad input is a 400 that names the problem and stores nothing", async () => {
  await seedMembers();
  const before = store.loadDb().projects.length;
  for (const [body, pattern] of [
    [{ name: "x1x", source: { type: "image", image: "nginx; rm -rf /" } }, /image must look like/],
    [{ name: "x1x", repo: "o/r", port: 99999 }, /port/],
    [{ name: "x1x", repo: "file:///etc" }, /not allowed/],
    [{ name: "x1x", repo: "o/r", branch: "--upload-pack=sh" }, /branch/],
    [{ name: "x1x", repo: "o/r", volumePath: "/a:/b" }, /volumePath/],
    [{ repo: "o/r" }, /Missing name/],
  ] as const) {
    const r = await create("t-ada", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, pattern);
  }
  assert.equal(store.loadDb().projects.length, before);
});

test("malformed JSON is a 400, not a stack trace", async () => {
  const r = await h.call("POST", "/api/projects", {
    token: "t-boss",
    rawBody: "{not json",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "Request body is not valid JSON");
});

test("an image project is created from an image reference", async () => {
  await seedMembers();
  const r = await create("t-ada", { name: "webimage", source: { type: "image", image: "nginx:1.27" }, port: 80 });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.project.source, { type: "image", image: "nginx:1.27" });
  assert.equal(r.body.project.repo, "nginx:1.27");
});

test("a private-repository token is accepted, stored, and never shown again", async () => {
  await seedMembers();
  const token = "ghp_neverShowThis123";
  const created = await create("t-ada", { name: "private", source: { type: "git", repo: "ada/private", token } });
  assert.equal(created.status, 201);
  assert.ok(!JSON.stringify(created.body).includes(token));
  assert.equal(created.body.project.source.hasToken, true);
  const id = created.body.project.id;

  for (const [method, route] of [["GET", `/api/projects/${id}`], ["GET", "/api/projects"]] as const) {
    const r = await h.call(method, route, { token: "t-ada" });
    assert.ok(!JSON.stringify(r.body).includes(token), `${method} ${route}`);
  }
  const updated = await h.call("PUT", `/api/projects/${id}`, { token: "t-ada", body: { branch: "dev" } });
  assert.ok(!JSON.stringify(updated.body).includes(token));
  const stored = store.loadDb().projects[0]?.source as { token?: string } | undefined;
  assert.equal(stored?.token, token, "still stored, because cloning needs it");

  const cleared = await h.call("PUT", `/api/projects/${id}`, { token: "t-ada", body: { token: null } });
  assert.equal(cleared.body.project.source.hasToken, false);
});

test("environment variables are validated and stored for the owner only", async () => {
  await seedMembers();
  const id = (await create("t-ada", { name: "envapp", repo: "o/r" })).body.project.id;
  assert.equal((await h.call("PUT", `/api/projects/${id}/env`, { token: "t-ada", body: { env: { A: "1" } } })).status, 200);
  assert.deepEqual(store.loadDb().projects[0]?.env, { A: "1" });
  assert.equal((await h.call("PUT", `/api/projects/${id}/env`, { token: "t-ada", body: { env: { "bad name": "1" } } })).status, 400);
  assert.equal((await h.call("PUT", `/api/projects/${id}/env`, { token: "t-ada", body: { env: { A: "x\ny" } } })).status, 400);
  assert.equal((await h.call("PUT", `/api/projects/${id}/env`, { token: "t-bob", body: { env: { A: "1" } } })).status, 404);
});

test("regenerating the webhook secret changes it for the owner only", async () => {
  await seedMembers();
  const created = (await create("t-ada", { name: "hooked", repo: "o/r" })).body.project;
  const r = await h.call("POST", `/api/projects/${created.id}/regen-webhook-secret`, { token: "t-ada" });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.webhookSecret, created.webhookSecret);
  assert.equal(store.loadDb().projects[0]?.webhookSecret, r.body.webhookSecret);
});

test("the node's safeguards are visible to members", async () => {
  await seedMembers();
  const r = await h.call("GET", "/api/limits", { token: "t-ada" });
  assert.equal(r.status, 200);
  assert.equal(r.body.limits.maxProjects, DEFAULT_LIMITS.maxProjects);
  assert.equal(r.body.availability, "best-effort");
  assert.equal(r.body.controlHost, "deploy.example.test");
});

test("who did what is recorded for operators, and carries no address", async () => {
  await seedMembers();
  await create("t-ada", { name: "audited", repo: "o/r" });
  assert.equal((await h.call("GET", "/api/admin/audit", { token: "t-ada" })).status, 403);
  const audit = (await h.call("GET", "/api/admin/audit", { token: "t-boss" })).body.audit as Array<Record<string, unknown>>;
  assert.deepEqual(audit.map((e) => e["action"]).sort(), ["member.grant", "member.grant", "member.grant", "project.create"]);
  for (const entry of audit) assert.deepEqual(Object.keys(entry).sort().filter((k) => !["subject"].includes(k)), ["action", "actor", "at", "id"]);
});

test("an unknown API path is a JSON 404", async () => {
  const r = await h.call("GET", "/api/nothing-here", { token: "t-boss" });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "Not found");
});
