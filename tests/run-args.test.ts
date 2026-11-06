import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRunArgs, validateVolumePath, type RunSpec } from "../src/lib/run-args.js";

const spec: RunSpec = {
  name: "nexus-app-demo-1a2b3c4d",
  image: "nexus/demo:1a2b3c4d",
  appPort: 3000,
  hostPort: 20123,
  envFile: "/tmp/nexus-env-x/env",
  limits: { memory: "512m", cpus: "0.5", pids: 256 },
};

const pairs = (args: string[]) => args.flatMap((a, i) => (a.startsWith("-") ? [[a, args[i + 1] ?? ""]] : []));
const valuesOf = (args: string[], flag: string) => pairs(args).filter(([f]) => f === flag).map(([, v]) => v);

test("the container drops every capability and cannot gain any", () => {
  const args = buildRunArgs(spec);
  assert.deepEqual(valuesOf(args, "--cap-drop"), ["ALL"]);
  assert.deepEqual(valuesOf(args, "--security-opt"), ["no-new-privileges"]);
  assert.ok(!args.includes("--privileged"));
  assert.ok(!args.some((a) => a.startsWith("--cap-add")));
});

test("memory, swap, cpu and process caps are set, and swap equals memory (none)", () => {
  const args = buildRunArgs(spec);
  assert.deepEqual(valuesOf(args, "--memory"), ["512m"]);
  assert.deepEqual(valuesOf(args, "--memory-swap"), ["512m"]);
  assert.deepEqual(valuesOf(args, "--cpus"), ["0.5"]);
  assert.deepEqual(valuesOf(args, "--pids-limit"), ["256"]);
});

test("logs use the capped local driver, not Docker's unbounded default", () => {
  const args = buildRunArgs(spec);
  assert.deepEqual(valuesOf(args, "--log-driver"), ["local"]);
  assert.deepEqual(valuesOf(args, "--log-opt"), ["max-size=10m", "max-file=2", "compress=false"]);
});

test("the app is published on loopback only", () => {
  const publishes = valuesOf(buildRunArgs(spec), "-p");
  assert.deepEqual(publishes, ["127.0.0.1:20123:3000"]);
});

test("the environment travels in a file, never on the command line", () => {
  const args = buildRunArgs(spec);
  assert.deepEqual(valuesOf(args, "--env-file"), ["/tmp/nexus-env-x/env"]);
  assert.ok(!args.includes("-e") && !args.includes("--env"));
});

test("nothing from the host is mounted and the host network is never used", () => {
  const args = buildRunArgs(spec);
  assert.ok(!args.includes("-v") && !args.includes("--volume") && !args.includes("--mount"));
  assert.ok(!args.includes("--network") && !args.includes("--net"));
  assert.ok(!args.some((a) => a.startsWith("traefik.")));
});

test("a project volume is a named volume at an absolute path, nothing else", () => {
  const args = buildRunArgs({ ...spec, volume: { name: "nexus-vol-demo", path: "/data" } });
  assert.deepEqual(valuesOf(args, "-v"), ["nexus-vol-demo:/data"]);
});

test("volume and container names that could smuggle options are refused", () => {
  for (const bad of ["", "relative", "/a:/b", "/a/../etc", "/a b", "/a,b", "/a;b", "/x".repeat(150)]) {
    assert.throws(() => validateVolumePath(bad), /volumePath/, bad);
  }
  assert.equal(validateVolumePath("/data/app-1"), "/data/app-1");
  assert.throws(() => buildRunArgs({ ...spec, name: "bad name" }), /container name/);
  assert.throws(() => buildRunArgs({ ...spec, name: "--rm" }), /container name/);
  assert.throws(() => buildRunArgs({ ...spec, volume: { name: "../x", path: "/data" } }), /volume name/);
  assert.throws(() => buildRunArgs({ ...spec, volume: { name: "v", path: "/a:/b" } }), /volumePath/);
});

test("images are marked as managed, and the image is the last argument", () => {
  const args = buildRunArgs(spec);
  assert.deepEqual(valuesOf(args, "-l"), ["nexus.managed=true"]);
  assert.equal(args.at(-1), "nexus/demo:1a2b3c4d");
});
