import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_LIMITS } from "../src/lib/safeguards.js";
import type { Project } from "../src/types.js";
import { FakeRuntime, RecordingPublisher } from "./support/fakes.js";

// The config is read when the modules load, and node --test gives every file its
// own process, so a throwaway data directory here cannot touch anything else.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-flow-"));
process.env["DATA_DIR"] = dataDir;
process.env["APP_SECRET"] = "test-secret-test-secret-1234";
process.env["BASE_DOMAIN"] = "example.test";
process.env["SANDBOX_DOCKER_HOST"] = "unix:///does-not-exist.sock";
const store = await import("../src/lib/store.js");
const build = await import("../src/lib/build.js");
type Deps = import("../src/lib/build.js").DeployDeps;

const DIGEST = `sha256:${"c".repeat(64)}`;

function project(patch: Partial<Project> = {}): Project {
  return {
    id: "prj_1",
    ownerId: "ada",
    name: "demo",
    repo: "o/r",
    branch: "main",
    buildContext: ".",
    buildCommand: "",
    startCommand: "",
    volumePath: "/workspace",
    port: 3000,
    env: {},
    status: "idle",
    autoDeployEnabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function seed(...projects: Project[]) {
  store.saveDb({ users: [], projects, deployments: [], sessions: [], members: [] });
}

const projectOf = (id = "prj_1") => store.loadDb().projects.find((p) => p.id === id) as Project;
const deploymentOf = (id: string) => store.loadDb().deployments.find((d) => d.id === id);

function makeDeps(patch: Partial<Deps> = {}) {
  const calls: string[] = [];
  const runtime = new FakeRuntime();
  const publisher = new RecordingPublisher();
  const deps: Deps = {
    steps: {
      clone: async (_source, dir) => {
        calls.push("clone");
        fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM scratch\n");
      },
      buildImage: async (opts) => {
        calls.push(`build:${opts.tag}`);
      },
      pullImage: async (image) => {
        calls.push(`pull:${image}`);
        return DIGEST;
      },
    },
    runtime,
    publisher,
    limits: DEFAULT_LIMITS,
    baseDomain: "example.test",
    hostPattern: "{slug}.{BASE_DOMAIN}",
    portRange: { min: 20000, max: 20009 },
    isPortFree: async () => true,
    health: { timeoutMs: 200, intervalMs: 10 },
    drainMs: 0,
    tmpDir: dataDir,
    ...patch,
  };
  return { deps, calls, runtime, publisher };
}

async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("a Git deployment clones, builds, starts, publishes the route and goes live", async () => {
  const p = project();
  seed(p);
  const { deps, calls, runtime, publisher } = makeDeps();
  const dep = build.createDeployment(p, "abc123", "manual");

  await build.runDeploy(p, dep.id, deps);

  const finished = deploymentOf(dep.id);
  assert.equal(finished?.status, "live");
  assert.equal(finished?.imageTag, `nexus/demo:${dep.id.slice(-8)}`);
  const live = projectOf();
  assert.equal(live.status, "live");
  assert.equal(live.containerName, `nexus-app-demo-${dep.id.slice(-8)}`);
  assert.equal(live.domain, "demo.example.test");
  assert.ok(live.hostPort !== undefined && live.hostPort >= 20000 && live.hostPort <= 20009);
  assert.equal(live.pendingPort, undefined, "the reservation is released once the release is done");
  assert.deepEqual(calls, ["clone", `build:nexus/demo:${dep.id.slice(-8)}`]);
  assert.equal(publisher.published.length, 1);
  assert.equal(publisher.published[0]?.host, "demo.example.test");
  assert.equal(publisher.published[0]?.hostPort, live.hostPort);
  assert.equal(runtime.isAlive(live.containerName as string), true);
  assert.ok(finished?.logs.some((l) => l.includes("Live at https://demo.example.test")));
});

test("an image deployment pulls, pins the exact digest, and neither clones nor builds", async () => {
  const p = project({ repo: "nginx:1.27", branch: "", source: { type: "image", image: "nginx:1.27" } });
  seed(p);
  const { deps, calls } = makeDeps();
  const dep = build.createDeployment(p, "manual", "manual");

  await build.runDeploy(p, dep.id, deps);

  assert.deepEqual(calls, ["pull:nginx:1.27"]);
  assert.equal(deploymentOf(dep.id)?.status, "live");
  assert.equal(projectOf().imageTag, `nginx@${DIGEST}`, "rollback will restore these exact bytes");
});

test("a failed clone fails the deployment, and a token in the error never reaches the log", async () => {
  const token = "ghp_secret999abc";
  const p = project({ source: { type: "git", repo: "o/r", branch: "main", token } });
  seed(p);
  const { deps } = makeDeps({
    steps: {
      clone: async () => {
        throw new Error(`fatal: could not read from https://x-access-token:${token}@example.test/o/r`);
      },
      buildImage: async () => {},
      pullImage: async () => DIGEST,
    },
  });
  const dep = build.createDeployment(p, "abc", "manual");

  await build.runDeploy(p, dep.id, deps);

  const finished = deploymentOf(dep.id);
  assert.equal(finished?.status, "failed");
  assert.equal(projectOf().status, "failed");
  const text = (finished?.logs ?? []).join("\n");
  assert.ok(text.includes("Build failed"));
  assert.ok(!text.includes(token), "the token is redacted");
  assert.ok(text.includes("***"));
});

test("a build that fails leaves the release that was already serving untouched", async () => {
  const p = project({
    status: "live",
    containerName: "nexus-app-demo-oldoldol",
    hostPort: 20005,
    imageTag: "nexus/demo:old",
  });
  seed(p);
  const { deps, runtime } = makeDeps({
    steps: {
      clone: async () => {
        throw new Error("network down");
      },
      buildImage: async () => {},
      pullImage: async () => DIGEST,
    },
  });
  runtime.seed("nexus-app-demo-oldoldol");
  const dep = build.createDeployment(p, "abc", "manual");

  await build.runDeploy(p, dep.id, deps);

  assert.equal(deploymentOf(dep.id)?.status, "failed");
  assert.equal(projectOf().status, "live", "the project is still serving its previous release");
  assert.equal(runtime.isAlive("nexus-app-demo-oldoldol"), true);
});

test("an unhealthy release is rejected and the previous one keeps serving", async () => {
  const p = project({
    status: "live",
    containerName: "nexus-app-demo-oldoldol",
    hostPort: 20005,
    imageTag: "nexus/demo:old",
  });
  seed(p);
  const { deps, runtime, publisher } = makeDeps();
  runtime.seed("nexus-app-demo-oldoldol");
  for (let port = 20000; port <= 20009; port++) runtime.probes.set(port, [503]);
  const dep = build.createDeployment(p, "abc", "manual");

  await build.runDeploy(p, dep.id, deps);

  assert.equal(deploymentOf(dep.id)?.status, "failed");
  assert.equal(projectOf().status, "live");
  assert.equal(projectOf().containerName, "nexus-app-demo-oldoldol");
  assert.equal(projectOf().pendingPort, undefined);
  assert.equal(publisher.published.length, 0);
  assert.equal(runtime.isAlive("nexus-app-demo-oldoldol"), true);
  assert.ok(deploymentOf(dep.id)?.logs.some((l) => l.includes("Release rejected")));
});

test("a successful release records the image it replaced, so rollback survives pruning", async () => {
  const p = project({
    status: "live",
    containerName: "nexus-app-demo-oldoldol",
    hostPort: 20005,
    imageTag: "nexus/demo:old",
  });
  seed(p);
  const { deps, runtime } = makeDeps();
  runtime.seed("nexus-app-demo-oldoldol");
  const dep = build.createDeployment(p, "abc", "manual");
  await build.runDeploy(p, dep.id, deps);
  assert.equal(projectOf().previousImageTag, "nexus/demo:old");
  assert.equal(projectOf().imageTag, `nexus/demo:${dep.id.slice(-8)}`);
  assert.equal(runtime.isAlive("nexus-app-demo-oldoldol"), false, "the old release stopped after the route moved");
});

test("cancelling a running build stops it and marks it cancelled", async () => {
  const p = project();
  seed(p);
  const { deps, calls } = makeDeps({
    steps: {
      clone: (_source, _dir, _log, track) =>
        new Promise((_resolve, reject) => {
          calls.push("clone");
          track(() => reject(new Error("killed")));
        }),
      buildImage: async () => {},
      pullImage: async () => DIGEST,
    },
  });
  const dep = build.createDeployment(p, "abc", "manual");
  const running = build.runDeploy(p, dep.id, deps);
  await until(() => calls.includes("clone"), "the clone to start");

  assert.equal(await build.cancelBuild(dep.id), true);
  await running;

  assert.equal(deploymentOf(dep.id)?.status, "cancelled");
  assert.equal(build.isBuilding(p.id), false);
});

test("a build that outlives its time limit is stopped and reported", async () => {
  const p = project();
  seed(p);
  const { deps } = makeDeps({
    limits: { ...DEFAULT_LIMITS, buildTimeoutMs: 40 },
    steps: {
      clone: (_source, _dir, _log, track) => new Promise((_resolve, reject) => track(() => reject(new Error("killed")))),
      buildImage: async () => {},
      pullImage: async () => DIGEST,
    },
  });
  const dep = build.createDeployment(p, "abc", "manual");
  await build.runDeploy(p, dep.id, deps);

  assert.equal(deploymentOf(dep.id)?.status, "failed");
  assert.ok(deploymentOf(dep.id)?.logs.some((l) => l.includes("Build exceeded")));
});

test("a second build of the same project is refused while one is running", async () => {
  const p = project();
  seed(p);
  const calls: string[] = [];
  const { deps } = makeDeps({
    steps: {
      clone: (_source, _dir, _log, track) =>
        new Promise((_resolve, reject) => {
          calls.push("clone");
          track(() => reject(new Error("killed")));
        }),
      buildImage: async () => {},
      pullImage: async () => DIGEST,
    },
  });
  const first = build.createDeployment(p, "one", "manual");
  const running = build.runDeploy(p, first.id, deps);
  await until(() => calls.includes("clone"), "the first clone to start");

  const second = build.createDeployment(p, "two", "manual");
  await build.runDeploy(p, second.id, deps);
  assert.equal(deploymentOf(second.id)?.status, "failed");
  assert.ok(deploymentOf(second.id)?.logs.some((l) => l.includes("Another build is already running")));

  await build.cancelBuild(first.id);
  await running;
});

test("a rollback starts the recorded image without cloning or building", async () => {
  const p = project({ status: "live", containerName: "nexus-app-demo-oldoldol", hostPort: 20005, imageTag: "nexus/demo:new" });
  seed(p);
  const { deps, calls, runtime } = makeDeps();
  runtime.seed("nexus-app-demo-oldoldol");
  const dep = build.createDeployment(p, "rollback:abc", "rollback");

  await build.runRollback(p, dep.id, "nexus/demo:old", deps);

  assert.deepEqual(calls, []);
  assert.equal(deploymentOf(dep.id)?.status, "live");
  assert.equal(projectOf().imageTag, "nexus/demo:old");
  assert.equal(projectOf().previousImageTag, "nexus/demo:new");
});

test("two projects releasing at once never pick the same port", async () => {
  const a = project({ id: "prj_a", name: "alpha" });
  const b = project({ id: "prj_b", name: "bravo" });
  seed(a, b);
  const first = makeDeps();
  const second = makeDeps();
  const depA = build.createDeployment(a, "x", "manual");
  const depB = build.createDeployment(b, "y", "manual");

  await Promise.all([build.runDeploy(a, depA.id, first.deps), build.runDeploy(b, depB.id, second.deps)]);

  const portA = projectOf("prj_a").hostPort;
  const portB = projectOf("prj_b").hostPort;
  assert.ok(portA !== undefined && portB !== undefined);
  assert.notEqual(portA, portB);
});

test("the queued deployment's first log lines never show a token", () => {
  const p = project({ source: { type: "git", repo: "o/r", branch: "main", token: "ghp_visible123" } });
  seed(p);
  const dep = build.createDeployment(p, "abc", "manual");
  assert.ok(!dep.logs.join("\n").includes("ghp_visible123"));
  assert.ok(dep.logs.join("\n").includes("repo=o/r"));
});
