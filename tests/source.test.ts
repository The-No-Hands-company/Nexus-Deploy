import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { test } from "node:test";
import { toEnvFile, validateEnv } from "../src/lib/env.js";
import {
  gitCredentialEnv,
  pinnedImageRef,
  publicProject,
  redact,
  sourceOf,
  validateBranch,
  validateImageRef,
  validateToken,
} from "../src/lib/source.js";
import type { Project } from "../src/types.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

test("image references: real ones are accepted", () => {
  for (const ok of [
    "nginx",
    "nginx:1.27",
    "library/nginx:latest",
    "ghcr.io/org/app:v1.2.3",
    "localhost:5000/foo/bar:tag",
    "registry.example.test:8443/team/app_name.v2",
    `repo/app@${DIGEST}`,
    `ghcr.io/org/app:1.0@${DIGEST}`,
  ]) {
    assert.equal(validateImageRef(ok), ok);
  }
});

test("image references: anything a shell or docker option could read is refused", () => {
  for (const bad of [
    "",
    "a b",
    "nginx;rm -rf /",
    "$(id)",
    "`id`",
    "nginx\nbusybox",
    "-v /:/host nginx",
    "--privileged",
    "Nginx",
    "nginx:",
    "nginx@sha256:short",
    `${"a".repeat(256)}`,
    "ghcr.io//app",
  ]) {
    assert.throws(() => validateImageRef(bad), /image must look like/, JSON.stringify(bad));
  }
  assert.throws(() => validateImageRef(undefined), /image must look like/);
  assert.throws(() => validateImageRef(42), /image must look like/);
});

test("pinning replaces the tag with the exact digest", () => {
  assert.equal(pinnedImageRef("nginx:1.27", DIGEST), `nginx@${DIGEST}`);
  assert.equal(pinnedImageRef("localhost:5000/foo/bar:tag", DIGEST), `localhost:5000/foo/bar@${DIGEST}`);
  assert.equal(pinnedImageRef(`ghcr.io/o/a:1@${DIGEST}`, DIGEST), `ghcr.io/o/a@${DIGEST}`);
  assert.equal(pinnedImageRef("busybox", DIGEST), `busybox@${DIGEST}`);
  assert.throws(() => pinnedImageRef("nginx", "latest"), /digest/);
});

test("branches are plain names, never options or traversal", () => {
  for (const ok of ["main", "release/1.2", "feat_x-1", "v2.0"]) assert.equal(validateBranch(ok), ok);
  for (const bad of ["", "-x", "--upload-pack=sh", "a..b", "a b", "a;b", "x".repeat(101)]) {
    assert.throws(() => validateBranch(bad), /branch must be/, bad);
  }
});

test("tokens: sane length, no whitespace", () => {
  assert.equal(validateToken("ghp_abcdef123456"), "ghp_abcdef123456");
  for (const bad of ["", "abc", "with space", "line\nbreak", "x".repeat(513), undefined]) {
    assert.throws(() => validateToken(bad), /token must be/);
  }
});

test("an older project with only repo and branch is a Git project", () => {
  assert.deepEqual(sourceOf({ repo: "o/r", branch: "main" }), { type: "git", repo: "o/r", branch: "main" });
  assert.deepEqual(sourceOf({ repo: "x", branch: "", source: { type: "image", image: "nginx" } }), {
    type: "image",
    image: "nginx",
  });
});

test("the git credential helper hands git the token without the token being in the script", () => {
  const { env, cleanup } = gitCredentialEnv("ghp_supersecret123", os.tmpdir());
  try {
    const script = env["GIT_ASKPASS"] as string;
    assert.ok(fs.existsSync(script));
    assert.notEqual(fs.statSync(script).mode & 0o100, 0, "script is executable");
    assert.equal(fs.statSync(script).mode & 0o077, 0, "script is private to the owner");
    assert.ok(!fs.readFileSync(script, "utf8").includes("ghp_supersecret123"), "the script holds no secret");
    assert.equal(env["GIT_TERMINAL_PROMPT"], "0");

    const ask = (prompt: string) =>
      spawnSync(script, [prompt], { env, encoding: "utf8" }).stdout;
    assert.equal(ask("Username for 'https://example.test': "), "x-access-token");
    assert.equal(ask("Password for 'https://x-access-token@example.test': "), "ghp_supersecret123");
  } finally {
    cleanup();
  }
});

test("user:token supplies the username, and cleanup removes the helper", () => {
  const { env, cleanup } = gitCredentialEnv("oauth2:glpat-abcdef", os.tmpdir());
  const script = env["GIT_ASKPASS"] as string;
  assert.equal(spawnSync(script, ["Username for x"], { env, encoding: "utf8" }).stdout, "oauth2");
  assert.equal(spawnSync(script, ["Password for x"], { env, encoding: "utf8" }).stdout, "glpat-abcdef");
  cleanup();
  assert.ok(!fs.existsSync(script));
});

test("with no token, git is simply told never to prompt", () => {
  const { env, cleanup } = gitCredentialEnv(undefined);
  assert.deepEqual(env, { GIT_TERMINAL_PROMPT: "0" });
  cleanup();
});

test("secrets are replaced wherever they appear in a log line", () => {
  assert.equal(redact("clone https://u:ghp_abc123@host failed: ghp_abc123", ["ghp_abc123"]), "clone https://u:***@host failed: ***");
  assert.equal(redact("nothing to hide", ["ghp_abc123", undefined, ""]), "nothing to hide");
  assert.equal(redact("ab is too short to redact", ["ab"]), "ab is too short to redact");
});

test("the API shows that a token exists but never its value", () => {
  const project = {
    id: "p",
    repo: "o/r",
    branch: "main",
    source: { type: "git", repo: "o/r", branch: "main", token: "ghp_topsecret" },
    webhookSecret: "w",
  } as unknown as Project;
  const shown = publicProject(project);
  assert.deepEqual(shown.source, { type: "git", repo: "o/r", branch: "main", hasToken: true });
  assert.ok(!JSON.stringify(shown).includes("ghp_topsecret"));
  assert.deepEqual(publicProject({ ...project, source: { type: "git", repo: "o/r", branch: "main" } }).source, {
    type: "git",
    repo: "o/r",
    branch: "main",
    hasToken: false,
  });
});

test("environment variables: names and values that docker's env file cannot hold are refused", () => {
  assert.deepEqual(validateEnv({ A: "1", _B2: "two words" }), { A: "1", _B2: "two words" });
  assert.throws(() => validateEnv([]), /object/);
  assert.throws(() => validateEnv(null), /object/);
  assert.throws(() => validateEnv({ "1A": "x" }), /valid environment variable name/);
  assert.throws(() => validateEnv({ "A B": "x" }), /valid environment variable name/);
  assert.throws(() => validateEnv({ A: 1 }), /must be a string/);
  assert.throws(() => validateEnv({ A: "line\nbreak" }), /line break/);
  assert.throws(() => validateEnv({ A: "x".repeat(4097) }), /longer than/);
  assert.throws(() => validateEnv(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`K${i}`, "v"]))), /at most/);
});

test("the env file is one name=value per line", () => {
  assert.equal(toEnvFile({ A: "1", B: "x=y" }), "A=1\nB=x=y\n");
});
