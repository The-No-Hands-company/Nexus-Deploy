import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  RAILPACK_FRONTEND,
  RAILPACK_VERSION,
  buildImageWithRunner,
  railpackDockerBuildArgs,
  railpackPrepareArgs,
  resolveRailpackBin,
} from "../src/lib/build-steps.js";

const SCRIPT = path.resolve(import.meta.dirname, "../sandbox/install-builder.sh");

function runInstall(args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
}

test("install-builder.sh is valid bash and --help explains its options", () => {
  const check = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const help = runInstall(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--install-dir/);
});

test("install-builder.sh --print outputs the pinned Railpack version, digests and target path", () => {
  const res = runInstall(["--print", "--install-dir", "/tmp/custom-bin"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^BUILDER=railpack$/m);
  assert.match(res.stdout, new RegExp(`^RAILPACK_VERSION=${RAILPACK_VERSION}$`, "m"));
  assert.match(
    res.stdout,
    /^RAILPACK_TARBALL_SHA256=248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb$/m,
  );
  assert.match(
    res.stdout,
    /^RAILPACK_BINARY_SHA256=3e9a8477b2c7cd0bfb46ebdb0ca5f3153329f4f01cec263dbb6ea9b4679a3af9$/m,
  );
  assert.match(res.stdout, /^RAILPACK_BIN=\/tmp\/custom-bin\/railpack$/m);
});

test("install-builder.sh rejects relative --install-dir and unknown options", () => {
  const rel = runInstall(["--print", "--install-dir", "relative/bin"]);
  assert.notEqual(rel.status, 0);
  assert.match(rel.stderr, /absolute path/);

  const bad = runInstall(["--not-a-flag"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown option/);
});

test("resolveRailpackBin prefers RAILPACK_BIN, then ~/.local/bin/railpack, then PATH", () => {
  assert.equal(
    resolveRailpackBin({ RAILPACK_BIN: "/opt/railpack" }, "/home/ops", () => true),
    "/opt/railpack",
  );
  assert.equal(
    resolveRailpackBin({}, "/home/ops", (p) => p === "/home/ops/.local/bin/railpack"),
    "/home/ops/.local/bin/railpack",
  );
  assert.equal(
    resolveRailpackBin({}, "/home/ops", () => false),
    "railpack",
  );
});

test("railpackPrepareArgs and railpackDockerBuildArgs construct the two-stage build commands", () => {
  const base = { contextDir: "/work/app", dockerfile: null, tag: "nexus/demo:12345678" };
  assert.deepEqual(railpackPrepareArgs(base, "/tmp/plan.json"), [
    "prepare",
    "/work/app",
    "--plan-out",
    "/tmp/plan.json",
    "--error-missing-start",
  ]);
  assert.deepEqual(
    railpackPrepareArgs(
      { ...base, buildCommand: "npm run build", startCommand: "node dist/index.js" },
      "/tmp/plan.json",
    ),
    [
      "prepare",
      "/work/app",
      "--plan-out",
      "/tmp/plan.json",
      "--error-missing-start",
      "--build-cmd",
      "npm run build",
      "--start-cmd",
      "node dist/index.js",
    ],
  );
  assert.deepEqual(railpackDockerBuildArgs(base, "/tmp/plan.json"), [
    "build",
    "--build-arg",
    `BUILDKIT_SYNTAX=${RAILPACK_FRONTEND}`,
    "-f",
    "/tmp/plan.json",
    "-t",
    "nexus/demo:12345678",
    "/work/app",
  ]);
});

test("buildImageWithRunner uses docker build directly when a Dockerfile is present", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  await buildImageWithRunner(
    { contextDir: "/work/app", dockerfile: "/work/app/Dockerfile", tag: "nexus/demo:abc" },
    () => {},
    () => {},
    async (cmd, args) => {
      calls.push({ cmd, args });
    },
    "/usr/local/bin/railpack",
  );
  assert.deepEqual(calls, [
    {
      cmd: "docker",
      args: ["build", "-t", "nexus/demo:abc", "-f", "/work/app/Dockerfile", "/work/app"],
    },
  ]);
});

test("buildImageWithRunner runs railpack prepare then docker build and removes the temp plan", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let recordedPlanPath = "";
  await buildImageWithRunner(
    {
      contextDir: "/work/app",
      dockerfile: null,
      tag: "nexus/demo:abc",
      buildCommand: "npm run compile",
    },
    () => {},
    () => {},
    async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd.endsWith("railpack")) {
        const idx = args.indexOf("--plan-out");
        recordedPlanPath = args[idx + 1] ?? "";
        fs.writeFileSync(recordedPlanPath, "{}");
      }
    },
    "/home/ops/.local/bin/railpack",
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.cmd, "/home/ops/.local/bin/railpack");
  assert.ok(recordedPlanPath.endsWith("railpack-plan.json"));
  assert.equal(calls[1]?.cmd, "docker");
  assert.deepEqual(calls[1]?.args, [
    "build",
    "--build-arg",
    `BUILDKIT_SYNTAX=${RAILPACK_FRONTEND}`,
    "-f",
    recordedPlanPath,
    "-t",
    "nexus/demo:abc",
    "/work/app",
  ]);
  assert.equal(fs.existsSync(path.dirname(recordedPlanPath)), false, "temp plan dir was removed");
});

test("buildImageWithRunner removes the temporary plan directory even when railpack fails", async () => {
  let recordedPlanDir = "";
  await assert.rejects(
    buildImageWithRunner(
      { contextDir: "/work/app", dockerfile: null, tag: "nexus/demo:abc" },
      () => {},
      () => {},
      async (_cmd, args) => {
        const idx = args.indexOf("--plan-out");
        const planPath = args[idx + 1] ?? "";
        recordedPlanDir = path.dirname(planPath);
        throw new Error("no start command found");
      },
      "railpack",
    ),
    /no start command found/,
  );
  assert.ok(recordedPlanDir.length > 0);
  assert.equal(fs.existsSync(recordedPlanDir), false, "temp plan dir cleaned up on error");
});
