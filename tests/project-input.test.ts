import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPatch, parseNewProject, parsePatch, parseSource, validateHealthPath, validatePort } from "../src/lib/project-input.js";
import { isPrivateHost, validateNotifyUrl } from "../src/lib/urls.js";
import type { Project } from "../src/types.js";

const git = { repo: "o/r", branch: "main", source: undefined as Project["source"] };

test("a webhook URL must be https and must not name a private or local address", () => {
  assert.equal(validateNotifyUrl("https://hooks.example.test/x"), "https://hooks.example.test/x");
  for (const bad of [
    "http://hooks.example.test/x",
    "https://user:pw@hooks.example.test/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://10.1.2.3/x",
    "https://172.16.0.9/x",
    "https://172.31.255.255/x",
    "https://192.168.1.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/x",
    "https://[::1]/x",
    "https://[fd00::1]/x",
    "https://[::ffff:127.0.0.1]/x",
    "https://printer.local/x",
    "ftp://example.test/x",
    "not a url",
    "",
  ]) {
    assert.throws(() => validateNotifyUrl(bad), /notifyUrl/, bad);
  }
  assert.equal(isPrivateHost("172.32.0.1"), false, "172.32 is public; only 172.16/12 is private");
  assert.equal(isPrivateHost("8.8.8.8"), false);
});

test("ports and health paths", () => {
  assert.equal(validatePort(3000), 3000);
  assert.equal(validatePort("8080"), 8080);
  for (const bad of [0, 65536, 1.5, "abc", null, undefined, -1]) assert.throws(() => validatePort(bad), /port/);
  assert.equal(validateHealthPath("/health"), "/health");
  assert.equal(validateHealthPath("/"), "/");
  for (const bad of ["health", "/a b", "/a\nb", "", 5]) assert.throws(() => validateHealthPath(bad), /healthPath/);
});

test("a source is either the nested form or the older flat repo and branch", () => {
  assert.deepEqual(parseSource({ repo: "o/r" }, false), { type: "git", repo: "o/r", branch: "main" });
  assert.deepEqual(parseSource({ repo: "o/r", branch: "dev", token: "ghp_abcd1234" }, false), {
    type: "git",
    repo: "o/r",
    branch: "dev",
    token: "ghp_abcd1234",
  });
  assert.deepEqual(parseSource({ source: { type: "image", image: "nginx:1.27" } }, false), {
    type: "image",
    image: "nginx:1.27",
  });
  assert.throws(() => parseSource({}, false), /Missing source/);
  assert.throws(() => parseSource({ source: { type: "svn" } }, false), /source.type/);
  assert.throws(() => parseSource({ source: { type: "image", image: "x; rm -rf /" } }, false), /image must look like/);
  assert.throws(() => parseSource({ repo: "file:///etc" }, false), /not allowed/);
  assert.throws(() => parseSource({ repo: "o/r", branch: "--upload-pack=x" }, false), /branch/);
  assert.throws(() => parseSource({ source: 5 }, false), /source must be/);
});

test("a new project needs a name and a source, and gets sensible defaults", () => {
  const p = parseNewProject({ name: "My App", repo: "o/r" }, false);
  assert.equal(p.name, "My App");
  assert.deepEqual(p.source, { type: "git", repo: "o/r", branch: "main" });
  assert.equal(p.port, 3000);
  assert.equal(p.volumePath, "/workspace");
  assert.equal(p.buildContext, ".");
  assert.throws(() => parseNewProject({ repo: "o/r" }, false), /Missing name/);
  assert.throws(() => parseNewProject("nope", false), /JSON object/);
  assert.throws(() => parseNewProject({ name: "x", repo: "o/r", volumePath: "/a:/b" }, false), /volumePath/);
  assert.throws(() => parseNewProject({ name: "x", repo: "o/r", port: 99999 }, false), /port/);
  assert.throws(() => parseNewProject({ name: "x", repo: "o/r", buildContext: "../up" }, false), /buildContext/);
  assert.throws(() => parseNewProject({ name: "x", repo: "o/r", buildCommand: "a\nb" }, false), /buildCommand/);
});

test("an image project ignores build settings that only apply to a repository", () => {
  const p = parseNewProject(
    { name: "web", source: { type: "image", image: "nginx" }, buildContext: "sub", dockerfile: "x/Dockerfile" },
    false,
  );
  assert.equal(p.buildContext, ".");
  assert.equal("dockerfile" in p, false);
});

test("a patch changes only what it names, and null clears an optional field", () => {
  const patch = parsePatch({ healthPath: "/up", memoryLimit: "256m", cpus: null, notifyUrl: "" }, git, false);
  assert.deepEqual(patch, { healthPath: "/up", memoryLimit: "256m", cpus: null, notifyUrl: null });
  assert.deepEqual(parsePatch({}, git, false), {});
  assert.throws(() => parsePatch({ memoryLimit: "lots" }, git, false), /memoryLimit/);
  assert.throws(() => parsePatch({ cpus: -1 }, git, false), /cpus/);
  assert.throws(() => parsePatch({ notifyUrl: "http://169.254.169.254/" }, git, false), /notifyUrl/);
  assert.throws(() => parsePatch("x", git, false), /JSON object/);
});

test("changing the branch keeps the repository and the stored token", () => {
  const current = { repo: "o/r", branch: "main", source: { type: "git" as const, repo: "o/r", branch: "main", token: "ghp_keepme123" } };
  assert.deepEqual(parsePatch({ branch: "dev" }, current, false).source, {
    type: "git",
    repo: "o/r",
    branch: "dev",
    token: "ghp_keepme123",
  });
  assert.deepEqual(parsePatch({ token: "ghp_newtoken1" }, current, false).source, {
    type: "git",
    repo: "o/r",
    branch: "main",
    token: "ghp_newtoken1",
  });
  assert.deepEqual(parsePatch({ token: null }, current, false).source, { type: "git", repo: "o/r", branch: "main" });
});

test("an image project's image can be changed, and a repo field is ignored for it", () => {
  const current = { repo: "nginx", branch: "", source: { type: "image" as const, image: "nginx" } };
  assert.deepEqual(parsePatch({ image: "nginx:1.28" }, current, false).source, { type: "image", image: "nginx:1.28" });
  assert.equal(parsePatch({ repo: "o/r" }, current, false).source, undefined);
});

test("applying a patch updates the project and keeps the display copy of the source in step", () => {
  const project = {
    repo: "o/r",
    branch: "main",
    source: { type: "git", repo: "o/r", branch: "main" },
    healthPath: "/old",
    cpus: "1",
    updatedAt: 1,
  } as unknown as Project;
  applyPatch(project, { source: { type: "image", image: "nginx:1" }, healthPath: null, cpus: null, port: 8080 }, 99);
  assert.equal(project.repo, "nginx:1");
  assert.equal(project.branch, "");
  assert.equal(project.port, 8080);
  assert.equal("healthPath" in project, false);
  assert.equal("cpus" in project, false);
  assert.equal(project.updatedAt, 99);
});
