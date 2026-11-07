import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { WebSocket } from "ws";
import { addDeployment, addProject, resetDb, startHarness } from "./support/app-harness.js";

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});
beforeEach(async () => {
  resetDb();
  await h.call("GET", "/api/projects", { token: "t-boss" });
  await h.call("POST", "/api/admin/members", { token: "t-boss", body: { authUserId: "ada" } });
  await h.call("POST", "/api/admin/members", { token: "t-boss", body: { authUserId: "bob" } });
});

type Outcome = { messages: Array<{ type: string; line?: string; status?: string }>; code: number };

function open(pathAndQuery: string, headers?: Record<string, string>): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${h.url.replace("http", "ws")}${pathAndQuery}`,
      headers ? { headers } : undefined,
    );
    const messages: Outcome["messages"] = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    socket.on("close", (code) => resolve({ messages, code }));
    socket.on("error", reject);
    setTimeout(() => socket.close(), 1500);
  });
}

test("no token, a bad token and an account that was never let in are all turned away", async () => {
  const p = addProject({ ownerId: "ada" });
  const dep = addDeployment({ projectId: p.id });
  for (const query of ["", "&token=nope", "&token=t-cy"]) {
    const r = await open(`/api/log-stream?deploymentId=${dep.id}${query}`);
    assert.equal(r.code, 1008, query);
    assert.deepEqual(r.messages, []);
  }
});

test("an owner receives their finished build's log and a done marker", async () => {
  const p = addProject({ ownerId: "ada" });
  const dep = addDeployment({ projectId: p.id, logs: ["one", "two"], status: "live" });
  const r = await open(`/api/log-stream?deploymentId=${dep.id}&token=t-ada`);
  assert.deepEqual(r.messages, [
    { type: "log", line: "one" },
    { type: "log", line: "two" },
    { type: "done", status: "live" },
  ]);
});

test("another member's build log is refused exactly like one that does not exist", async () => {
  const p = addProject({ ownerId: "bob" });
  const dep = addDeployment({ projectId: p.id, logs: ["secret line"] });
  const theirs = await open(`/api/log-stream?deploymentId=${dep.id}&token=t-ada`);
  const missing = await open("/api/log-stream?deploymentId=dep_missing&token=t-ada");
  assert.equal(theirs.code, 1008);
  assert.deepEqual(theirs.messages, []);
  assert.equal(missing.code, 1008);
});

test("an operator can watch any build", async () => {
  const p = addProject({ ownerId: "bob" });
  const dep = addDeployment({ projectId: p.id, logs: ["visible"], status: "failed" });
  const r = await open(`/api/log-stream?deploymentId=${dep.id}&token=t-boss`);
  assert.deepEqual(r.messages.at(0), { type: "log", line: "visible" });
});

test("a container's output streams to its owner and to nobody else", async () => {
  const p = addProject({ ownerId: "ada", name: "streamy", containerName: "nexus-app-streamy-x" });
  h.ops.logLines = ["hello from the app"];
  const mine = await open(`/api/container-stream?projectId=${p.id}&token=t-ada`);
  assert.ok(mine.messages.some((m) => m.type === "log" && m.line === "hello from the app"));
  assert.ok(h.ops.calls.includes("logs:nexus-app-streamy-x"));
  h.ops.calls.length = 0;
  const theirs = await open(`/api/container-stream?projectId=${p.id}&token=t-bob`);
  assert.equal(theirs.code, 1008);
  assert.deepEqual(h.ops.calls, [], "no log process was started for the wrong member");
});

test("browser WebSocket streams authenticate with the /api/me stream ticket or session cookie", async () => {
  const p = addProject({ ownerId: "ada" });
  const dep = addDeployment({ projectId: p.id, logs: ["via-ticket"], status: "live" });

  const me = await h.call("GET", "/api/me", { token: "t-ada" });
  assert.equal(me.status, 200);
  assert.equal(typeof me.body.wsToken, "string");
  assert.ok((me.body.wsToken as string).startsWith("wst1."));

  const byTicket = await open(
    `/api/log-stream?deploymentId=${dep.id}&token=${encodeURIComponent(me.body.wsToken as string)}`,
  );
  assert.deepEqual(byTicket.messages, [
    { type: "log", line: "via-ticket" },
    { type: "done", status: "live" },
  ]);

  const forgedTicket = await open(`/api/log-stream?deploymentId=${dep.id}&token=wst1.bad.sig`);
  assert.equal(forgedTicket.code, 1008);

  const byCookie = await open(`/api/log-stream?deploymentId=${dep.id}`, {
    Cookie: "nexus_session=t-ada",
  });
  assert.deepEqual(byCookie.messages, [
    { type: "log", line: "via-ticket" },
    { type: "done", status: "live" },
  ]);
});

test("/api/auth/login and /api/auth/logout redirect using the node's Auth URL and reject external redirects", async () => {
  const loginSafe = await fetch(`${h.url}/api/auth/login?redirect=%2Fprojects%2Fprj_1`, {
    redirect: "manual",
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "deploy.example.test" },
  });
  assert.equal(loginSafe.status, 302);
  assert.match(
    loginSafe.headers.get("location") ?? "",
    /\/login\?redirect=https%3A%2F%2Fdeploy\.example\.test%2Fprojects%2Fprj_1$/,
  );

  const loginExternal = await fetch(`${h.url}/api/auth/login?redirect=//evil.example/phish`, {
    redirect: "manual",
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "deploy.example.test" },
  });
  assert.equal(loginExternal.status, 302);
  assert.doesNotMatch(loginExternal.headers.get("location") ?? "", /evil\.example/);

  const logout = await fetch(`${h.url}/api/auth/logout`, { redirect: "manual" });
  assert.equal(logout.status, 302);
  assert.match(logout.headers.get("location") ?? "", /\/logout$/);
});
