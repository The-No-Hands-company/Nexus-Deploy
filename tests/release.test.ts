import assert from "node:assert/strict";
import { test } from "node:test";
import { performRelease, releaseContainerName, type ReleaseProject } from "../src/lib/release.js";
import { FakeRuntime, makeDeps, RecordingPublisher } from "./support/fakes.js";

const LIMITS = { memory: "512m", cpus: "0.5", pids: 256 };

const project = (patch: Partial<ReleaseProject> = {}): ReleaseProject => ({
  id: "prj_1",
  slug: "demo",
  host: "demo.example.test",
  appPort: 3000,
  env: { FOO: "bar" },
  limits: LIMITS,
  ...patch,
});

const OLD = { containerName: "nexus-app-demo-oldoldol", imageRef: "nexus/demo:old", hostPort: 20001 };

test("the container name is derived from the slug and the deployment", () => {
  assert.equal(releaseContainerName("demo", "dep_0123456789abcdef"), "nexus-app-demo-89abcdef");
});

test("blue/green: the old release keeps serving until the route has moved, then it stops", async () => {
  const runtime = new FakeRuntime();
  runtime.seed(OLD.containerName);
  const order: string[] = [];
  const publisher = new RecordingPublisher(order);
  const deps = makeDeps(runtime, publisher, [20002]);

  const outcome = await performRelease(project({ current: OLD }), "dep_new00001", "nexus/demo:new", deps);

  assert.equal(outcome.ok, true);
  const calls = runtime.calls;
  assert.ok(calls.indexOf("run:nexus-app-demo-new00001:20002") < calls.indexOf("probe:20002"));
  const removedOld = calls.indexOf(`remove:${OLD.containerName}`);
  assert.ok(removedOld > calls.indexOf("probe:20002"), "old stops only after the new one is proven");
  assert.deepEqual(order, ["publish:20002"], "the route moved exactly once, to the new port");
  assert.equal(runtime.isAlive(OLD.containerName), false);
  assert.equal(runtime.isAlive("nexus-app-demo-new00001"), true);
  assert.deepEqual(deps.clock.slept.filter((ms) => ms === 10_000), [10_000], "the old release drained first");
  assert.deepEqual(outcome, {
    ok: true,
    containerName: "nexus-app-demo-new00001",
    hostPort: 20002,
    imageRef: "nexus/demo:new",
    mode: "blue-green",
  });
});

test("an unhealthy release is removed and the old one never stops serving", async () => {
  const runtime = new FakeRuntime();
  runtime.seed(OLD.containerName);
  runtime.probes.set(20002, [503]);
  runtime.tails.set("nexus-app-demo-new00001", ["Error: cannot find module", "exit 1"]);
  const publisher = new RecordingPublisher();
  const deps = makeDeps(runtime, publisher, [20002]);

  const outcome = await performRelease(project({ current: OLD, healthPath: "/health" }), "dep_new00001", "nexus/demo:new", deps);

  assert.equal(outcome.ok, false);
  assert.equal((outcome as { servingPrevious: boolean }).servingPrevious, true);
  assert.match((outcome as { reason: string }).reason, /503/);
  assert.equal(publisher.published.length, 0, "the route was never touched");
  assert.equal(runtime.isAlive(OLD.containerName), true, "the old release is still running");
  assert.equal(runtime.isAlive("nexus-app-demo-new00001"), false, "the failed release is gone");
  assert.ok(!runtime.calls.includes(`remove:${OLD.containerName}`));
  assert.ok(deps.logs.some((l) => l.includes("[app] Error: cannot find module")), "the app's last output is shown");
});

test("a first release that fails has nothing to fall back on", async () => {
  const runtime = new FakeRuntime();
  runtime.probes.set(20002, [null]);
  const deps = makeDeps(runtime, new RecordingPublisher(), [20002]);
  const outcome = await performRelease(project(), "dep_new00001", "nexus/demo:new", deps);
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { servingPrevious: boolean }).servingPrevious, false);
});

test("a container that will not even start counts as an unhealthy release", async () => {
  const runtime = new FakeRuntime();
  runtime.seed(OLD.containerName);
  runtime.failRun.add("nexus-app-demo-new00001");
  const deps = makeDeps(runtime, new RecordingPublisher(), [20002]);
  const outcome = await performRelease(project({ current: OLD }), "dep_new00001", "nexus/demo:new", deps);
  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /did not start: port is already allocated/);
  assert.equal(runtime.isAlive(OLD.containerName), true);
});

test("if the route cannot be published the new release is removed and the old keeps serving", async () => {
  const runtime = new FakeRuntime();
  runtime.seed(OLD.containerName);
  const publisher = new RecordingPublisher();
  publisher.fail = true;
  const deps = makeDeps(runtime, publisher, [20002]);
  const outcome = await performRelease(project({ current: OLD }), "dep_new00001", "nexus/demo:new", deps);
  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /could not publish the route: cloud unreachable/);
  assert.equal((outcome as { servingPrevious: boolean }).servingPrevious, true);
  assert.equal(runtime.isAlive(OLD.containerName), true);
  assert.equal(runtime.isAlive("nexus-app-demo-new00001"), false);
});

test("a slow start that becomes healthy in time is accepted", async () => {
  const runtime = new FakeRuntime();
  runtime.probes.set(20002, [null, null, 200]);
  const deps = makeDeps(runtime, new RecordingPublisher(), [20002]);
  const outcome = await performRelease(project(), "dep_new00001", "nexus/demo:new", deps);
  assert.equal(outcome.ok, true);
});

test("the container gets the node's limits, the app port, and PORT in its environment", async () => {
  const runtime = new FakeRuntime();
  const deps = makeDeps(runtime, new RecordingPublisher(), [20002]);
  await performRelease(project({ appPort: 8080, env: { PORT: "9999", FOO: "bar" } }), "dep_new00001", "img", deps);
  const spec = runtime.specs[0];
  assert.deepEqual(spec?.limits, LIMITS);
  assert.equal(spec?.appPort, 8080);
  assert.equal(spec?.hostPort, 20002);
  assert.equal(spec?.env["NODE_ENV"], "production");
  assert.equal(spec?.env["FOO"], "bar");
  assert.equal(spec?.env["PORT"], "9999", "a member's own PORT wins, as before");
});

test("a declared health path is probed and must answer 2xx; otherwise any non-5xx on / will do", async () => {
  const strict = new FakeRuntime();
  strict.probes.set(20002, [404]);
  const a = await performRelease(project({ healthPath: "/health" }), "dep_new00001", "img", makeDeps(strict, new RecordingPublisher(), [20002]));
  assert.equal(a.ok, false, "404 is not healthy when a path is declared");

  const lenient = new FakeRuntime();
  lenient.probes.set(20002, [404]);
  const b = await performRelease(project(), "dep_new00001", "img", makeDeps(lenient, new RecordingPublisher(), [20002]));
  assert.equal(b.ok, true, "404 on / still proves the app is up when no path is declared");
});

test("a project with a volume stops the old release first, because two writers could corrupt it", async () => {
  const runtime = new FakeRuntime();
  runtime.seed(OLD.containerName);
  const deps = makeDeps(runtime, new RecordingPublisher(), [20002]);
  const volume = { name: "nexus-vol-demo", path: "/data" };
  const outcome = await performRelease(project({ current: OLD, volume }), "dep_new00001", "nexus/demo:new", deps);

  assert.equal(outcome.ok, true);
  assert.equal((outcome as { mode: string }).mode, "stop-start");
  const calls = runtime.calls;
  assert.ok(calls.indexOf(`remove:${OLD.containerName}`) < calls.indexOf("run:nexus-app-demo-new00001:20002"));
  assert.deepEqual(runtime.specs[0]?.volume, volume);
  assert.deepEqual(deps.clock.slept.filter((ms) => ms === 10_000), [], "no drain: the old one is already gone");
});

test("a failed volume release puts the previous image back on its own port", async () => {
  const runtime = new FakeRuntime();
  runtime.seed(OLD.containerName);
  runtime.probes.set(20002, [503]);
  const publisher = new RecordingPublisher();
  const deps = makeDeps(runtime, publisher, [20002]);
  const volume = { name: "nexus-vol-demo", path: "/data" };
  const outcome = await performRelease(project({ current: OLD, volume }), "dep_new00001", "nexus/demo:new", deps);

  assert.equal(outcome.ok, false);
  assert.equal((outcome as { servingPrevious: boolean }).servingPrevious, true);
  assert.ok(runtime.calls.includes(`run:${OLD.containerName}:20001`), "the previous image restarted on its old port");
  assert.equal(runtime.isAlive(OLD.containerName), true);
  assert.equal(publisher.published.length, 0, "the route never moved, so it still points at the old port");
});

test("if the restored volume release is unhealthy too, nothing is left running and we say so", async () => {
  const runtime = new FakeRuntime();
  runtime.seed(OLD.containerName);
  runtime.probes.set(20002, [503]);
  runtime.probes.set(20001, [503]);
  const deps = makeDeps(runtime, new RecordingPublisher(), [20002]);
  const outcome = await performRelease(
    project({ current: OLD, volume: { name: "nexus-vol-demo", path: "/data" } }),
    "dep_new00001",
    "nexus/demo:new",
    deps,
  );
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { servingPrevious: boolean }).servingPrevious, false);
  assert.equal(runtime.isAlive(OLD.containerName), false);
});
