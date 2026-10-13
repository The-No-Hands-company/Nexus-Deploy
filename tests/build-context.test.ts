import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-deploy-context-test-"));
process.env.DATA_DIR = path.join(temporary, "data");
process.env.APP_SECRET = "disposable-context-test-secret";  // pragma: allowlist secret (disposable test value)
const { loadDb, saveDb } = await import("../src/lib/store.js");
const auth = createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ authorized: true, userId: "test-user" }));
});
let child: ReturnType<typeof spawn>;
let base: string;

before(async () => {
  auth.listen(0, "127.0.0.1");
  await once(auth, "listening");
  const address = auth.address();
  assert(address && typeof address !== "string");
  const portServer = createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const portAddress = portServer.address();
  assert(portAddress && typeof portAddress !== "string");
  const port = portAddress.port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(port), NEXUS_AUTH_URL: `http://127.0.0.1:${address.port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", chunk => {
      output += chunk.toString();
      if (output.includes("NEXUS DEPLOY")) resolve();
    });
    child.once("exit", code => reject(new Error(`Deploy exited ${code}: ${output}`)));
    child.stderr!.on("data", chunk => { output += chunk.toString(); });
  });
});
after(async () => {
  child?.kill();
  if (child && child.exitCode === null) await once(child, "exit");
  await new Promise<void>(resolve => auth.close(() => resolve()));
  fs.rmSync(temporary, { recursive: true, force: true });
});
async function request(method: string, endpoint: string, body?: object) {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: { Authorization: "Bearer disposable", "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  assert(response.headers.get("content-type")?.includes("application/json"), text);
  return { status: response.status, body: JSON.parse(text) };
}

test("defaults new and legacy projects to the repository root", async () => {
  const created = await request("POST", "/api/projects", { name: "default", repo: "fixture/repo" });
  assert.equal(created.body.project.buildContext, ".");
  const db = loadDb();
  delete (db.projects[0] as { buildContext?: string }).buildContext;
  saveDb(db);
  assert.equal(loadDb().projects[0]?.buildContext, ".");
  const fetched = await request("GET", `/api/projects/${created.body.project.id}`);
  assert.equal(fetched.body.project.buildContext, ".");
});
test("persists a scoped context through create, update and read", async () => {
  const created = await request("POST", "/api/projects", {
    name: "scoped", repo: "fixture/repo", buildContext: "apps/Nexus-Calendar",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.project.buildContext, "apps/Nexus-Calendar");
  const endpoint = `/api/projects/${created.body.project.id}`;
  const updated = await request("PUT", endpoint, { buildContext: "apps/other" });
  assert.equal(updated.body.project.buildContext, "apps/other");
  assert.equal((await request("GET", endpoint)).body.project.buildContext, "apps/other");
  assert.equal((await request("PUT", endpoint, { branch: "release" })).body.project.buildContext, "apps/other");
});
test("rejects invalid create and update contexts without mutating projects", async () => {
  const created = await request("POST", "/api/projects", { name: "validation", repo: "fixture/repo" });
  for (const buildContext of ["", " ", "/tmp", "../outside", "apps/../outside", "C:\\temp", "apps\\other", "a\u0000b", 42, null, {}, []]) {
    const count = loadDb().projects.length;
    assert.equal((await request("POST", "/api/projects", { name: "invalid", repo: "fixture/repo", buildContext })).status, 400, String(buildContext));
    assert.equal(loadDb().projects.length, count);
    assert.equal((await request("PUT", `/api/projects/${created.body.project.id}`, { buildContext, branch: "must-not-change" })).status, 400, String(buildContext));
    assert.equal(loadDb().projects.find(p => p.id === created.body.project.id)?.branch, "main");
  }
});
test("refuses file: repositories at the door when local repos are not enabled", async () => {
  const count = loadDb().projects.length;
  const refused = await request("POST", "/api/projects", { name: "local", repo: "file:///srv/any-repo" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /not allowed/);
  assert.equal(loadDb().projects.length, count);
  const created = await request("POST", "/api/projects", { name: "remote", repo: "fixture/repo" });
  const update = await request("PUT", `/api/projects/${created.body.project.id}`, { repo: "file:///srv/any-repo" });
  assert.equal(update.status, 400);
  assert.equal(loadDb().projects.find(p => p.id === created.body.project.id)?.repo, "fixture/repo");
});
test("persists dockerfile and healthPath, and clears them with null", async () => {
  const created = await request("POST", "/api/projects", {
    name: "monorepo", repo: "fixture/repo", dockerfile: "apps/Nexus-Calendar/Dockerfile", healthPath: "/health",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.project.dockerfile, "apps/Nexus-Calendar/Dockerfile");
  assert.equal(created.body.project.healthPath, "/health");
  const endpoint = `/api/projects/${created.body.project.id}`;
  for (const bad of [{ dockerfile: "../Dockerfile" }, { healthPath: "health" }, { healthPath: "/a b" }]) {
    assert.equal((await request("PUT", endpoint, bad)).status, 400, JSON.stringify(bad));
  }
  const cleared = await request("PUT", endpoint, { dockerfile: null, healthPath: null });
  assert.equal(cleared.body.project.dockerfile, undefined);
  assert.equal(cleared.body.project.healthPath, undefined);
});
