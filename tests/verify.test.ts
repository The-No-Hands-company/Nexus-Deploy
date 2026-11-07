import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  VERIFY_STEPS,
  formatVerifyReport,
  runVerify,
  verifyExitCode,
} from "../src/verify/checks.js";
import type {
  DeployedFixture,
  FixtureKind,
  VerifyHarness,
  VerifyResult,
} from "../src/verify/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function fakeHarness(
  patch: Partial<VerifyHarness> = {},
): VerifyHarness & { cleanedUp: () => boolean } {
  const deployed = new Map<FixtureKind, DeployedFixture>();
  let cleaned = false;

  const base: VerifyHarness & { cleanedUp: () => boolean } = {
    baseDomain: "verify.test",
    controlHost: "deploy.verify.test",
    expectedMemoryBytes: 512 * 1024 * 1024,
    cleanedUp: () => cleaned,
    async deployFixture(kind) {
      const item: DeployedFixture = {
        kind,
        projectId: `prj_${kind}`,
        slug: `vfy-${kind}`,
        host: `vfy-${kind}.verify.test`,
        containerName: `nexus-app-vfy-${kind}-12345678`,
        firstDeploymentId: `dep_${kind}_1`,
      };
      deployed.set(kind, item);
      return item;
    },
    getFixture(kind) {
      return deployed.get(kind);
    },
    async edgeFetch(host, urlPath) {
      if (host === "deploy.verify.test" && urlPath === "/vfy-node") {
        const headers: Record<string, string> = { location: "https://vfy-node.verify.test/" };
        return {
          status: 302,
          headers,
          body: "",
        };
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      return {
        status: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          host,
          path: urlPath,
          headers: { host, accept: "*/*" },
        }),
      };
    },
    async probeContainerEgress() {
      return {
        loopbackReached: false,
        lanReached: false,
        lanTargets: ["192.168.0.10"],
      };
    },
    async inspectContainerCaps() {
      return {
        memoryMaxBytes: 512 * 1024 * 1024,
        logDriver: "local",
        logMaxSize: "10m",
        logMaxFile: "2",
        logCompress: "false",
      };
    },
    async exerciseReleaseLifecycle() {
      return {
        inFlightTotal: 18,
        inFlightFailed: 0,
        upgradedVersion: "v2",
        unhealthyDeploymentStatus: "failed",
        versionDuringUnhealthy: "v2",
        rolledBackVersion: "v1",
      };
    },
    async exerciseVolumePersistence() {
      return {
        project: {
          kind: "dockerfile",
          projectId: "prj_vol",
          slug: "vfy-vol",
          host: "vfy-vol.verify.test",
          containerName: "nexus-app-vfy-vol-12345678",
          firstDeploymentId: "dep_vol_1",
          volumeName: "nexus-vol-vfy-vol",
        },
        writtenMarker: "marker-123",
        readAfterRedeploy: "marker-123",
        versionAfterRedeploy: "v2",
      };
    },
    async deleteAllFixturesAndVerify() {
      return {
        remainingContainers: [],
        remainingRoutes: [],
        remainingSlugs: [],
        remainingVolumes: [],
      };
    },
    async cleanup() {
      cleaned = true;
    },
    ...patch,
  };
  return base;
}

const byId = (results: VerifyResult[], id: string): VerifyResult => {
  const found = results.find((r) => r.id === id);
  assert.ok(found, `missing result for ${id}`);
  return found;
};

test("bundled generic fixtures exist on disk and never reference any Nexus app", () => {
  for (const rel of [
    "node/package.json",
    "node/server.js",
    "python/requirements.txt",
    "python/main.py",
    "dockerfile/Dockerfile",
    "dockerfile/server.js",
  ]) {
    const full = path.join(FIXTURES_DIR, rel);
    assert.ok(fs.existsSync(full), `missing fixture file ${rel}`);
    const content = fs.readFileSync(full, "utf8");
    assert.ok(!/Nexus-(?!Deploy)/i.test(content), `${rel} must remain generic`);
  }
});

test("the bundled Dockerfile fixture server answers /, /volume and FAIL_HEALTH=true", async () => {
  const port = await freePort();
  const volDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-vol-"));
  const proc = spawn(process.execPath, [path.join(FIXTURES_DIR, "dockerfile/server.js")], {
    env: { ...process.env, PORT: String(port), RELEASE_VERSION: "v1", VOLUME_DIR: volDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { "X-Custom": "probe" },
        });
        if (r.status === 200) {
          const body = (await r.json()) as {
            ok: boolean;
            version: string;
            headers: Record<string, string>;
          };
          assert.equal(body.ok, true);
          assert.equal(body.version, "v1");
          assert.equal(body.headers["x-custom"], "probe");
          ready = true;
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    assert.equal(ready, true, "dockerfile fixture server started");

    const w = await fetch(`http://127.0.0.1:${port}/volume`, {
      method: "POST",
      body: "hello-volume",
    });
    assert.equal(w.status, 200);
    const rd = (await (await fetch(`http://127.0.0.1:${port}/volume`)).json()) as {
      value: string;
    };
    assert.equal(rd.value, "hello-volume");
  } finally {
    proc.kill("SIGTERM");
    fs.rmSync(volDir, { recursive: true, force: true });
  }
});

test("a conforming node passes all eight verification steps and runs cleanup", async () => {
  const h = fakeHarness();
  const results = await runVerify(h);
  assert.equal(results.length, VERIFY_STEPS.length);
  assert.deepEqual(
    results.map((r) => r.status),
    VERIFY_STEPS.map(() => "pass"),
  );
  assert.equal(verifyExitCode(results), 0);
  assert.equal(h.cleanedUp(), true);
  assert.match(formatVerifyReport(results), /8 passed, 0 failed, 0 skipped/);
});

test("a fixture build or route failure fails step 1 and skips the dependent steps", async () => {
  const h = fakeHarness({
    async edgeFetch(host) {
      return { status: host.includes("python") ? 502 : 200, headers: {}, body: "" };
    },
  });
  const results = await runVerify(h);
  assert.equal(byId(results, "fixtures-build-and-serve").status, "fail");
  assert.match(byId(results, "fixtures-build-and-serve").detail, /python.*502/);
  for (const step of VERIFY_STEPS.slice(1)) {
    assert.equal(byId(results, step.id).status, "skip", step.id);
  }
  assert.equal(verifyExitCode(results), 1);
  assert.equal(h.cleanedUp(), true);
});

test("leaked cookies, credentials, client IPs or visitor tags fail the header-stripping check", async () => {
  for (const leakedHeader of [
    "cookie",
    "authorization",
    "cf-connecting-ip",
    "x-nexus-client-tag",
  ]) {
    const base = fakeHarness();
    const h = fakeHarness({
      async edgeFetch(host, urlPath, init) {
        if (urlPath === "/echo") {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ headers: { [leakedHeader]: "leaked" } }),
          };
        }
        return base.edgeFetch(host, urlPath, init);
      },
    });
    const results = await runVerify(h);
    const r = byId(results, "proxy-strips-sensitive-headers");
    assert.equal(r.status, "fail", leakedHeader);
    assert.match(r.detail, new RegExp(leakedHeader));
  }
});

test("container egress to loopback or LAN, uncapped memory or logs, and broken short links each fail", async () => {
  const loopbackLeak = await runVerify(
    fakeHarness({
      probeContainerEgress: async () => ({
        loopbackReached: true,
        lanReached: false,
        lanTargets: [],
      }),
    }),
  );
  assert.equal(byId(loopbackLeak, "container-network-isolation").status, "fail");

  const lanLeak = await runVerify(
    fakeHarness({
      probeContainerEgress: async () => ({
        loopbackReached: false,
        lanReached: true,
        lanTargets: ["192.168.0.10"],
      }),
    }),
  );
  assert.equal(byId(lanLeak, "container-network-isolation").status, "fail");
  assert.match(byId(lanLeak, "container-network-isolation").detail, /192\.168\.0\.10/);

  const wrongMem = await runVerify(
    fakeHarness({
      inspectContainerCaps: async () => ({
        memoryMaxBytes: 1024 * 1024 * 1024,
        logDriver: "local",
        logMaxSize: "10m",
        logMaxFile: "2",
        logCompress: "false",
      }),
    }),
  );
  assert.equal(byId(wrongMem, "container-resource-and-log-caps").status, "fail");

  const wrongLogs = await runVerify(
    fakeHarness({
      inspectContainerCaps: async () => ({
        memoryMaxBytes: 512 * 1024 * 1024,
        logDriver: "json-file",
        logMaxSize: "",
        logMaxFile: "",
        logCompress: "",
      }),
    }),
  );
  assert.equal(byId(wrongLogs, "container-resource-and-log-caps").status, "fail");

  const base = fakeHarness();
  const brokenShortLink = await runVerify(
    fakeHarness({
      async edgeFetch(host, urlPath, init) {
        if (host === "deploy.verify.test") return { status: 404, headers: {}, body: "" };
        return base.edgeFetch(host, urlPath, init);
      },
    }),
  );
  assert.equal(byId(brokenShortLink, "short-link-redirect").status, "fail");
});

test("dropped requests during redeploy, accepted unhealthy releases, lost volume data and leftover resources fail", async () => {
  const dropped = await runVerify(
    fakeHarness({
      exerciseReleaseLifecycle: async () => ({
        inFlightTotal: 10,
        inFlightFailed: 2,
        upgradedVersion: "v2",
        unhealthyDeploymentStatus: "failed",
        versionDuringUnhealthy: "v2",
        rolledBackVersion: "v1",
      }),
    }),
  );
  assert.equal(byId(dropped, "zero-downtime-unhealthy-and-rollback").status, "fail");

  const lostVol = await runVerify(
    fakeHarness({
      exerciseVolumePersistence: async () => ({
        project: {
          kind: "dockerfile",
          projectId: "prj_vol",
          slug: "vfy-vol",
          host: "vfy-vol.verify.test",
          containerName: "c",
          firstDeploymentId: "d",
        },
        writtenMarker: "expected-data",
        readAfterRedeploy: "",
        versionAfterRedeploy: "v2",
      }),
    }),
  );
  assert.equal(byId(lostVol, "volume-persists-across-redeploy").status, "fail");

  const leftover = await runVerify(
    fakeHarness({
      deleteAllFixturesAndVerify: async () => ({
        remainingContainers: ["nexus-app-vfy-node-12345678"],
        remainingRoutes: [],
        remainingSlugs: ["vfy-node"],
        remainingVolumes: ["nexus-vol-vfy-vol"],
      }),
    }),
  );
  const del = byId(leftover, "delete-cleans-everything");
  assert.equal(del.status, "fail");
  assert.match(del.detail, /containers: nexus-app-vfy-node-12345678/);
  assert.match(del.detail, /slugs: vfy-node/);
  assert.match(del.detail, /volumes: nexus-vol-vfy-vol/);
});

test("cleanup always runs even when a step throws an exception", async () => {
  const h = fakeHarness({
    async probeContainerEgress() {
      throw new Error("docker exec crashed");
    },
  });
  const results = await runVerify(h);
  assert.equal(byId(results, "container-network-isolation").status, "fail");
  assert.match(byId(results, "container-network-isolation").detail, /docker exec crashed/);
  assert.equal(h.cleanedUp(), true);
});
