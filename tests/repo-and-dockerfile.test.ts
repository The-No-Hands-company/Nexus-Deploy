import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveRepoUrl } from "../src/lib/repo.js";
import { resolveDockerfile, validateDockerfile } from "../src/lib/build-context.js";

test("local file: repositories are refused unless explicitly allowed", () => {
  assert.throws(() => resolveRepoUrl("file:///srv/secret-repo", false), /not allowed/);
  assert.throws(() => resolveRepoUrl("FILE:///srv/secret-repo", false), /not allowed/);
  assert.equal(resolveRepoUrl("file:///tmp/fixture", true), "file:///tmp/fixture");
  assert.throws(() => resolveRepoUrl("file://evil.example/x", true), /local host/);
});

test("remote repositories are unaffected by the local-repo switch", () => {
  assert.equal(resolveRepoUrl("owner/repo", false), "https://github.com/owner/repo");
  assert.equal(resolveRepoUrl("https://forge.tnhc.dev/a/b.git", false), "https://forge.tnhc.dev/a/b.git");
});

test("other local transports are refused too", () => {
  for (const repo of ["/srv/secret-repo", "./relative", "../up", "ext::sh -c id"]) {
    assert.throws(() => resolveRepoUrl(repo, false), repo);
  }
});

test("dockerfile defaults to <context>/Dockerfile and may be set relative to the repo root", () => {
  assert.equal(validateDockerfile(undefined, "."), "Dockerfile");
  assert.equal(validateDockerfile(undefined, "apps/x"), "apps/x/Dockerfile");
  assert.equal(validateDockerfile("apps/Nexus-Calendar/Dockerfile", "."), "apps/Nexus-Calendar/Dockerfile");
  for (const bad of ["", "/etc/passwd", "../Dockerfile", "a/../../b", "a\\b", 7]) {
    assert.throws(() => validateDockerfile(bad, "."), String(bad));
  }
});

test("resolveDockerfile returns null when absent and refuses symlinks out of the clone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-dockerfile-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-dockerfile-out-"));
  try {
    fs.mkdirSync(path.join(root, "apps/cal"), { recursive: true });
    assert.equal(resolveDockerfile(root, "apps/cal/Dockerfile"), null);
    fs.writeFileSync(path.join(root, "apps/cal/Dockerfile"), "FROM scratch\n");
    assert.equal(resolveDockerfile(root, "apps/cal/Dockerfile"), path.join(fs.realpathSync(root), "apps/cal/Dockerfile"));
    fs.writeFileSync(path.join(outside, "Dockerfile"), "FROM scratch\n");
    fs.symlinkSync(path.join(outside, "Dockerfile"), path.join(root, "Escaped"));
    assert.throws(() => resolveDockerfile(root, "Escaped"), /inside/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
