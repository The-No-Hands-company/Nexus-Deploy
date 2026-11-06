import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

// node --test runs each file in its own process, so this cannot leak into other
// tests. The config is read when the module loads, hence the dynamic imports.
process.env["SANDBOX_DOCKER_HOST"] = "";
const { childEnv, parseImageList, parseRepoDigest, SandboxNotConfigured, spawnStream } = await import(
  "../src/lib/docker.js"
);
const { probeLoopback } = await import("../src/lib/health.js");

const SANDBOX = "unix:///run/user/1001/docker.sock";

test("docker and the builder are pointed at the sandbox, overriding anything ambient", () => {
  const env = childEnv("docker", SANDBOX, {
    PATH: "/bin",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    DOCKER_CONTEXT: "default",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: "/certs",
  });
  assert.equal(env["DOCKER_HOST"], SANDBOX);
  assert.equal(env["PATH"], "/bin");
  assert.equal("DOCKER_CONTEXT" in env, false);
  assert.equal("DOCKER_TLS_VERIFY" in env, false);
  assert.equal("DOCKER_CERT_PATH" in env, false);
  assert.equal(childEnv("nixpacks", SANDBOX, {})["DOCKER_HOST"], SANDBOX);
});

test("with no sandbox configured, docker and the builder refuse to run at all", () => {
  assert.throws(() => childEnv("docker", "", { DOCKER_HOST: "unix:///var/run/docker.sock" }), SandboxNotConfigured);
  assert.throws(() => childEnv("nixpacks", ""), /Refusing to use the host's Docker daemon/);
});

test("other commands are untouched, so git needs no sandbox", () => {
  const base = { PATH: "/bin", FOO: "1" };
  assert.deepEqual(childEnv("git", "", base), base);
});

test("a docker command fails closed through the real spawn path when no sandbox is set", async () => {
  // The test environment sets no SANDBOX_DOCKER_HOST, which is exactly the misconfiguration.
  await assert.rejects(spawnStream("docker", ["version"], () => {}), SandboxNotConfigured);
});

test("a command that outlives its timeout is killed and reported", async () => {
  await assert.rejects(
    spawnStream("sleep", ["5"], () => {}, undefined, { timeoutMs: 100 }),
    /timed out/,
  );
});

test("spawnStream passes extra environment to the child and streams its output", async () => {
  const lines: string[] = [];
  await spawnStream("sh", ["-c", 'echo "$NEXUS_T"'], (l) => lines.push(l), undefined, { env: { NEXUS_T: "hello" } });
  assert.deepEqual(lines, ["hello"]);
});

test("a digest is read out of a repo-digest line, and only a real one", () => {
  const digest = `sha256:${"b".repeat(64)}`;
  assert.equal(parseRepoDigest(`nginx@${digest}`), digest);
  assert.equal(parseRepoDigest("nginx:latest"), null);
  assert.equal(parseRepoDigest("nginx@sha256:short"), null);
});

test("the image listing is parsed, skipping malformed lines", () => {
  const rows = parseImageList([
    "nginx\t1.27\tsha256:abc\t0123456789ab",
    "<none>\t<none>\t<none>\tdeadbeef0000",
    "garbage",
  ]);
  assert.deepEqual(rows, [
    { repository: "nginx", tag: "1.27", digest: "sha256:abc", id: "0123456789ab" },
    { repository: "<none>", tag: "<none>", digest: "<none>", id: "deadbeef0000" },
  ]);
});

test("the loopback probe returns the status an app answers with, or null", async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = req.url === "/health" ? 200 : 503;
    res.end("x");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    assert.equal(await probeLoopback(port, "/health"), 200);
    assert.equal(await probeLoopback(port, "/other"), 503);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(await probeLoopback(port, "/health", 300), null);
});
