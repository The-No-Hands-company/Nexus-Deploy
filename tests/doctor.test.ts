import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECKS } from "../src/doctor/checks.js";
import { exitCode, formatReport, runChecks, summarize } from "../src/doctor/run.js";
import type { CheckResult, Ctx, DockerResult, Listener } from "../src/doctor/types.js";

const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });

const GOOD_LOG = JSON.stringify({
  Type: "local",
  Config: { "max-size": "10m", "max-file": "2", compress: "false" },
});

/**
 * A node where everything is right. `reach` lists the targets a container could
 * connect to, which is how the fake lets a test open a hole.
 */
function fakeCtx(over: Partial<Ctx> = {}, reach: string[] = []): Ctx & { calls: string[][] } {
  const calls: string[][] = [];
  let lastTarget = "";
  const accepted = new Map<number, number>();
  let nextPort = 40000;
  const ctx: Ctx & { calls: string[][] } = {
    calls,
    sandboxHost: "unix:///run/nexus-deploy-sandbox/docker.sock",
    storagePath: "/var/lib/nexus-deploy-sandbox/storage",
    expectedStorageGb: 12,
    limits: { memory: "512m", cpus: "0.5", pids: 256 },
    probeImage: "busybox:1.36",
    async docker(args) {
      calls.push(args);
      const joined = args.join(" ");
      if (args[0] === "info" && joined.includes("{{json .}}"))
        return ok('{"ServerVersion":"29.8.2"}');
      if (args[0] === "info") return ok('["name=seccomp,profile=builtin","name=rootless"]');
      if (args[0] === "image") return ok();
      if (args[0] === "create" || args[0] === "rm") return ok();
      if (args[0] === "inspect") return ok(GOOD_LOG);
      if (joined.includes("/proc/self/status"))
        return ok("CapEff:\t0000000000000000\nNoNewPrivs:\t1\n");
      if (joined.includes("nslookup")) return ok("2\n");
      const nc = /nc -w 3 (\S+) (\d+)/.exec(joined);
      if (nc?.[1] && nc[2]) {
        lastTarget = nc[1];
        if (reach.includes(lastTarget)) {
          const port = Number(nc[2]);
          accepted.set(port, (accepted.get(port) ?? 0) + 1);
        }
        return ok();
      }
      return ok();
    },
    builder: async () => ok("railpack version 0.43.0\n"),
    cloudUrl: "http://127.0.0.1:8787",
    cloudUserAppsKey: "uakey-test",
    probeCloud: async () => ({
      ok: true,
      detail: "http://127.0.0.1:8787 (user-apps key accepted)",
    }),
    baseDomain: "example.test",
    resolveHost: async () => ["203.0.113.10"],
    fileExists: () => true,
    device: (p) => (p.endsWith("/..") ? 1 : 2),
    fsUsage: () => ({ totalBytes: 12 * 1024 ** 3, freeBytes: 11 * 1024 ** 3 }),
    hostAddresses: () => ["192.168.0.10"],
    async listen(): Promise<Listener> {
      const port = nextPort++;
      return { port, accepted: () => accepted.get(port) ?? 0, close() {} };
    },
    ...over,
  };
  return ctx;
}

const byId = (results: CheckResult[], id: string) => {
  const r = results.find((x) => x.id === id);
  assert.ok(r, `no result for ${id}`);
  return r;
};

test("a correctly set-up node passes every check", async () => {
  const results = await runChecks(fakeCtx());
  assert.deepEqual(
    results.map((r) => r.status),
    results.map(() => "pass"),
  );
  assert.equal(results.length, CHECKS.length);
  assert.equal(exitCode(results), 0);
});

test("an unset sandbox is a failure that skips everything which needs it", async () => {
  const results = await runChecks(fakeCtx({ sandboxHost: "" }));
  assert.equal(byId(results, "sandbox-configured").status, "fail");
  for (const id of [
    "sandbox-daemon",
    "sandbox-rootless",
    "sandbox-probe-image",
    "sandbox-log-caps",
    "sandbox-hardening",
    "sandbox-no-host-loopback",
    "sandbox-no-lan",
    "sandbox-dns",
  ]) {
    assert.equal(byId(results, id).status, "skip", id);
  }
  assert.equal(exitCode(results), 1);
});

test("the host's own Docker daemon is never accepted as the sandbox", async () => {
  for (const path of ["/var/run/docker.sock", "/run/docker.sock"]) {
    const results = await runChecks(fakeCtx({ sandboxHost: `unix://${path}` }));
    const r = byId(results, "sandbox-configured");
    assert.equal(r.status, "fail");
    assert.match(r.detail, /host's own Docker daemon/);
  }
});

test("a missing socket, a dead daemon and a root daemon are each reported", async () => {
  const noSocket = await runChecks(fakeCtx({ fileExists: () => false }));
  assert.match(byId(noSocket, "sandbox-configured").detail, /does not exist/);

  const dead = await runChecks(
    fakeCtx({
      docker: async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }),
    }),
  );
  assert.equal(byId(dead, "sandbox-daemon").status, "fail");
  assert.equal(byId(dead, "sandbox-rootless").status, "skip");

  const base = fakeCtx();
  const rootDaemon = await runChecks({
    ...base,
    docker: async (args, t) =>
      args[0] === "info" && !args.join(" ").includes("{{json .}}")
        ? ok('["name=seccomp,profile=builtin"]')
        : base.docker(args, t),
  });
  assert.equal(byId(rootDaemon, "sandbox-rootless").status, "fail");
});

test("uncapped logs and weakened containers are failures", async () => {
  const base = fakeCtx();
  const uncapped = await runChecks({
    ...base,
    docker: async (args, t) =>
      args[0] === "inspect"
        ? ok(JSON.stringify({ Type: "json-file", Config: {} }))
        : base.docker(args, t),
  });
  assert.equal(byId(uncapped, "sandbox-log-caps").status, "fail");

  for (const status of [
    "CapEff:\t00000000a80425fb\nNoNewPrivs:\t1\n",
    "CapEff:\t0000000000000000\nNoNewPrivs:\t0\n",
  ]) {
    const weak = await runChecks({
      ...base,
      docker: async (args, t) =>
        args.join(" ").includes("/proc/self/status") ? ok(status) : base.docker(args, t),
    });
    assert.equal(byId(weak, "sandbox-hardening").status, "fail", status);
  }
});

test("the probes run with the real isolation flags", async () => {
  const ctx = fakeCtx();
  await runChecks(ctx);
  const probeRuns = ctx.calls.filter((a) => a[0] === "run");
  assert.ok(probeRuns.length >= 3);
  for (const args of probeRuns) {
    for (const flag of [
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
    ]) {
      assert.ok(args.includes(flag), `${flag} in ${args.join(" ")}`);
    }
  }
});

test("storage must be its own filesystem, no bigger than its cap, and not nearly full", async () => {
  const shared = await runChecks(fakeCtx({ device: () => 7 }));
  assert.equal(byId(shared, "sandbox-storage").status, "fail");
  assert.match(byId(shared, "sandbox-storage").detail, /same filesystem as its parent/);

  const missing = await runChecks(fakeCtx({ device: () => null }));
  assert.equal(byId(missing, "sandbox-storage").status, "fail");

  const unset = await runChecks(fakeCtx({ storagePath: "" }));
  assert.equal(byId(unset, "sandbox-storage").status, "fail");

  const tooBig = await runChecks(
    fakeCtx({ fsUsage: () => ({ totalBytes: 40 * 1024 ** 3, freeBytes: 30 * 1024 ** 3 }) }),
  );
  assert.equal(byId(tooBig, "sandbox-storage").status, "fail");

  const nearlyFull = await runChecks(
    fakeCtx({ fsUsage: () => ({ totalBytes: 12 * 1024 ** 3, freeBytes: 1 * 1024 ** 3 }) }),
  );
  assert.equal(byId(nearlyFull, "sandbox-storage").status, "warn");
  assert.equal(exitCode(nearlyFull), 0, "a warning does not fail the doctor");
});

test("a container that reaches the host's loopback is a failure", async () => {
  const results = await runChecks(fakeCtx({}, ["10.0.2.2"]));
  const r = byId(results, "sandbox-no-host-loopback");
  assert.equal(r.status, "fail");
  assert.match(r.fix ?? "", /DISABLE_HOST_LOOPBACK/);
});

test("a container that reaches the machine through a LAN address is a failure that names it", async () => {
  const results = await runChecks(
    fakeCtx({ hostAddresses: () => ["192.168.0.10", "172.20.0.1"] }, ["172.20.0.1"]),
  );
  const r = byId(results, "sandbox-no-lan");
  assert.equal(r.status, "fail");
  assert.match(r.detail, /172\.20\.0\.1/);
  assert.ok(!r.detail.includes("192.168.0.10"));
  assert.match(r.fix ?? "", /egress filter/);
});

test("a machine with no LAN address cannot be tested and says so", async () => {
  const results = await runChecks(fakeCtx({ hostAddresses: () => [] }));
  assert.equal(byId(results, "sandbox-no-lan").status, "warn");
});

test("a sandbox that cannot resolve names is a failure, because builds would break", async () => {
  const base = fakeCtx();
  const results = await runChecks({
    ...base,
    docker: async (args, t) =>
      args.join(" ").includes("nslookup") ? ok("0\n") : base.docker(args, t),
  });
  assert.equal(byId(results, "sandbox-dns").status, "fail");
});

test("a check that throws is a failure of that check, not of the run", async () => {
  const base = fakeCtx();
  const results = await runChecks({
    ...base,
    docker: async (args, t) => {
      if (args[0] === "inspect") throw new Error("boom");
      return base.docker(args, t);
    },
  });
  assert.match(byId(results, "sandbox-log-caps").detail, /boom/);
  assert.equal(byId(results, "sandbox-dns").status, "pass");
});

test("a missing builder binary is reported with the install command", async () => {
  const results = await runChecks(
    fakeCtx({
      builder: async () => ({ code: 127, stdout: "", stderr: "spawn railpack ENOENT" }),
    }),
  );
  const r = byId(results, "builder-installed");
  assert.equal(r.status, "fail");
  assert.match(r.detail, /ENOENT/);
  assert.match(r.fix ?? "", /sandbox\/install-builder\.sh/);
});

test("Cloud registration warns in standalone mode and fails when misconfigured or rejected", async () => {
  const standalone = await runChecks(fakeCtx({ cloudUrl: "", cloudUserAppsKey: "" }));
  assert.equal(byId(standalone, "cloud-registration").status, "warn");
  assert.equal(exitCode(standalone), 0);

  const missingKey = await runChecks(fakeCtx({ cloudUserAppsKey: "" }));
  assert.equal(byId(missingKey, "cloud-registration").status, "fail");
  assert.match(byId(missingKey, "cloud-registration").detail, /NEXUS_CLOUD_USER_APPS_KEY/);

  const rejected = await runChecks(
    fakeCtx({ probeCloud: async () => ({ ok: false, detail: "HTTP 403" }) }),
  );
  assert.equal(byId(rejected, "cloud-registration").status, "fail");
  assert.match(byId(rejected, "cloud-registration").detail, /HTTP 403/);
});

test("the wildcard domain check accepts loopback domains and fails when DNS does not resolve", async () => {
  const loopback = await runChecks(
    fakeCtx({ baseDomain: "localhost", resolveHost: async () => [] }),
  );
  assert.equal(byId(loopback, "wildcard-domain").status, "pass");

  const empty = await runChecks(fakeCtx({ baseDomain: "" }));
  assert.equal(byId(empty, "wildcard-domain").status, "fail");

  const unresolvable = await runChecks(fakeCtx({ resolveHost: async () => [] }));
  const r = byId(unresolvable, "wildcard-domain");
  assert.equal(r.status, "fail");
  assert.match(r.detail, /doctor-probe\.example\.test/);
  assert.match(r.fix ?? "", /\*\.example\.test/);
});

test("the report names each result and ends with a tally; fixes are shown for failures only", async () => {
  const results = await runChecks(fakeCtx({ device: () => 7 }));
  const text = formatReport(results);
  assert.match(text, /FAIL {2}The sandbox has its own size-capped filesystem/);
  assert.match(text, /fix: Run sandbox\/setup\.sh again/);
  assert.match(text, /12 passed, 1 failed, 0 warnings, 0 skipped/);
  assert.deepEqual(summarize(results), { passed: 12, warnings: 0, failed: 1, skipped: 0 });
  assert.ok(!formatReport(await runChecks(fakeCtx())).includes("fix:"));
});
