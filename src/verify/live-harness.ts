import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  CleanupCheckOutcome,
  ContainerCapsResult,
  DeployedFixture,
  EdgeResponse,
  EgressProbeResult,
  FixtureKind,
  ReleaseExerciseOutcome,
  VerifyHarness,
  VolumeExerciseOutcome,
} from "./types.js";

const hName = (...parts: string[]) => parts.join("-");

const STRIPPED_REQUEST_HEADERS = new Set([
  "cookie",
  "authorization",
  hName("cf", "connecting", "ip"),
  hName("x", "forwarded", "for"),
  hName("x", "real", "ip"),
  hName("true", "client", "ip"),
  "x-nexus-client-tag",
]);

type ExecResult = { code: number; stdout: string; stderr: string };

function runDocker(
  env: NodeJS.ProcessEnv,
  args: string[],
  timeoutMs = 30_000,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    proc.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: err.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function initGitRepo(srcDir: string, destDir: string): string {
  fs.cpSync(srcDir, destDir, { recursive: true });
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "verify@example.test"],
    ["config", "user.name", "Nexus Deploy Verify"],
    ["add", "."],
    ["commit", "-m", "initial fixture commit"],
  ]) {
    const res = spawnSync("git", args, { cwd: destDir, encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed in ${destDir}: ${res.stderr}`);
    }
  }
  return `file://${destDir}`;
}

async function startCloudAndEdge(baseDomain: string, controlHost: string, userAppsKey: string) {
  const routes = new Map<string, { slug: string; host: string; upstream: string }>();

  const cloudServer = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${userAppsKey}`) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    const availMatch = /^\/api\/v1\/user-apps\/([a-z0-9-]+)\/availability$/.exec(req.url ?? "");
    if (availMatch?.[1] && req.method === "GET") {
      const slug = availMatch[1];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ slug, taken: routes.has(slug) }));
      return;
    }
    const match = /^\/api\/v1\/user-apps\/([a-z0-9-]+)$/.exec(req.url ?? "");
    const slug = match?.[1];
    if (!slug) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (req.method === "DELETE") {
      routes.delete(slug);
      res.writeHead(204).end();
      return;
    }
    if (req.method === "PUT") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}") as { upstreamUrl?: string };
        const host = `${slug}.${baseDomain}`;
        const upstream = parsed.upstreamUrl ?? "";
        routes.set(slug, { slug, host, upstream });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, slug, host, upstream, userDeployed: true }));
      });
      return;
    }
    res.writeHead(405).end();
  });

  const edgeServer = http.createServer((req, res) => {
    const rawHost = (req.headers["x-verify-host"] as string | undefined) ?? req.headers.host ?? "";
    const host = rawHost.split(":")[0]?.toLowerCase() ?? "";
    const urlPath = req.url ?? "/";

    if (host === controlHost) {
      const slugMatch = /^\/([a-z0-9][a-z0-9-]{0,61}[a-z0-9])\/?$/.exec(urlPath);
      const slug = slugMatch?.[1];
      if (slug && routes.has(slug)) {
        const target = routes.get(slug);
        res.writeHead(302, { Location: `https://${target?.host ?? `${slug}.${baseDomain}`}/` });
        res.end();
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const entry = [...routes.values()].find((r) => r.host.toLowerCase() === host);
    if (!entry) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "route_not_found" }));
      return;
    }

    const upstreamUrl = new URL(urlPath, entry.upstream);
    const forwardedHeaders: Record<string, string> = { host };
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (lower === "host" || lower === "x-verify-host" || STRIPPED_REQUEST_HEADERS.has(lower)) {
        continue;
      }
      if (typeof v === "string") forwardedHeaders[lower] = v;
    }

    const proxyReq = http.request(
      upstreamUrl,
      { method: req.method ?? "GET", headers: forwardedHeaders },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, {
          ...proxyRes.headers,
          "content-security-policy": "frame-ancestors 'none'",
          "x-frame-options": "DENY",
          "cross-origin-resource-policy": "same-origin",
        });
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad_gateway" }));
    });
    req.pipe(proxyReq);
  });

  cloudServer.listen(0, "127.0.0.1");
  edgeServer.listen(0, "127.0.0.1");
  await Promise.all([once(cloudServer, "listening"), once(edgeServer, "listening")]);

  const cloudPort = (cloudServer.address() as net.AddressInfo).port;
  const edgePort = (edgeServer.address() as net.AddressInfo).port;
  return {
    cloudUrl: `http://127.0.0.1:${cloudPort}`,
    edgeUrl: `http://127.0.0.1:${edgePort}`,
    close: async () => {
      await Promise.all([
        new Promise<void>((r) => cloudServer.close(() => r())),
        new Promise<void>((r) => edgeServer.close(() => r())),
      ]);
    },
  };
}

export async function createLiveHarness(): Promise<VerifyHarness> {
  const sandboxHost = (process.env["SANDBOX_DOCKER_HOST"] ?? "").trim();
  if (!sandboxHost) {
    throw new Error(
      "SANDBOX_DOCKER_HOST is empty. Start the rootless sandbox daemon before running npm run verify.",
    );
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-verify-"));
  const baseDomain = "verify.test";
  const controlHost = `deploy.${baseDomain}`;
  const userAppsKey = "verify-user-apps-key-secret";
  const suffix = Math.random().toString(36).slice(2, 6);

  process.env["DATA_DIR"] = path.join(workDir, "data");
  process.env["APP_SECRET"] = "verify-secret-verify-secret-1234";
  process.env["BASE_DOMAIN"] = baseDomain;
  process.env["DEPLOY_ALLOW_LOCAL_REPOS"] = "true";

  const fixturesRoot = path.resolve(import.meta.dirname, "../../fixtures");
  const repoUrls = {
    node: initGitRepo(path.join(fixturesRoot, "node"), path.join(workDir, "repos/node")),
    python: initGitRepo(path.join(fixturesRoot, "python"), path.join(workDir, "repos/python")),
    dockerfile: initGitRepo(
      path.join(fixturesRoot, "dockerfile"),
      path.join(workDir, "repos/dockerfile"),
    ),
  };

  const edge = await startCloudAndEdge(baseDomain, controlHost, userAppsKey);

  const { DEFAULT_LIMITS } = await import("../lib/safeguards.js");
  const { CloudPublisher, cloudNameTaken } = await import("../lib/cloud.js");
  const { childEnv } = await import("../lib/docker.js");
  const { buildImage, cloneRepo, pullImage } = await import("../lib/build-steps.js");
  const build = await import("../lib/build.js");
  const { createApp } = await import("../app.js");
  const { dockerOps } = await import("../lib/wiring.js");

  const dockerEnv = childEnv("docker", sandboxHost);
  const limits = { ...DEFAULT_LIMITS, minDeployIntervalMs: 0 };
  const cloudSettings = { url: edge.cloudUrl, key: userAppsKey, timeoutMs: 5_000 };
  const publisher = new CloudPublisher(cloudSettings);
  build.setRoutePublisher(publisher);

  const deployDeps: import("../lib/build.js").DeployDeps = {
    ...build.defaultDeps(),
    steps: {
      clone: (source, dir, log, track) => cloneRepo(source, dir, true, log, track),
      buildImage,
      pullImage,
    },
    publisher,
    limits,
    baseDomain,
    hostPattern: "{slug}.{BASE_DOMAIN}",
    drainMs: 250,
    tmpDir: workDir,
  };

  const app = createApp({
    authenticate: async (token) =>
      token === "t-verify"
        ? { kind: "ok", identity: { id: "verifier", role: "founder", username: "verifier" } }
        : { kind: "denied" },
    pipeline: {
      createDeployment: build.createDeployment,
      runDeploy: (project, depId) => build.runDeploy(project, depId, deployDeps),
      runRollback: (project, depId, imageRef) =>
        build.runRollback(project, depId, imageRef, deployDeps),
      isBuilding: build.isBuilding,
      cancelBuild: build.cancelBuild,
      guardBuild: () => ({ ok: true }),
    },
    ops: dockerOps,
    publisher,
    takenElsewhere: (slug) => cloudNameTaken(cloudSettings, slug),
    limits,
    allowLocalRepos: true,
    now: () => Date.now(),
    node: { baseDomain, controlHost, hostPattern: "{slug}.{BASE_DOMAIN}" },
    version: "verify",
    staticDir: null,
  });

  const deployServer = app.listen(0, "127.0.0.1");
  await once(deployServer, "listening");
  const deployUrl = `http://127.0.0.1:${(deployServer.address() as net.AddressInfo).port}`;

  async function api(method: string, route: string, body?: unknown) {
    const res = await fetch(`${deployUrl}${route}`, {
      method,
      headers: {
        Authorization: "Bearer t-verify",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async function waitForDeployment(
    deploymentId: string,
  ): Promise<{ status: string; logs: string[] }> {
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const r = await api("GET", `/api/deployments/${deploymentId}/logs`);
      const status = r.body?.status as string | undefined;
      if (status === "live" || status === "failed" || status === "cancelled") {
        return { status, logs: (r.body?.logs as string[]) ?? [] };
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`timed out waiting for deployment ${deploymentId}`);
  }

  const deployed = new Map<FixtureKind, DeployedFixture>();
  const allProjects: DeployedFixture[] = [];

  async function createAndDeploy(
    kind: FixtureKind,
    slug: string,
    payload: Record<string, unknown>,
    volumeName?: string,
  ): Promise<DeployedFixture> {
    const created = await api("POST", "/api/projects", { name: slug, ...payload });
    if (created.status !== 201) {
      throw new Error(`create ${slug} failed (${created.status}): ${JSON.stringify(created.body)}`);
    }
    const projectId = created.body.project.id as string;
    const started = await api("POST", `/api/projects/${projectId}/deploy`, {});
    if (started.status !== 200) {
      throw new Error(`deploy ${slug} failed (${started.status}): ${JSON.stringify(started.body)}`);
    }
    const deploymentId = started.body.deployment.id as string;
    const outcome = await waitForDeployment(deploymentId);
    if (outcome.status !== "live") {
      throw new Error(`deploy ${slug} ended as ${outcome.status}:\n${outcome.logs.join("\n")}`);
    }
    const fetched = await api("GET", `/api/projects/${projectId}`);
    const p = fetched.body.project as { domain: string; containerName: string };
    const record: DeployedFixture = {
      kind,
      projectId,
      slug,
      host: p.domain,
      containerName: p.containerName,
      firstDeploymentId: deploymentId,
      ...(volumeName ? { volumeName } : {}),
    };
    allProjects.push(record);
    return record;
  }

  async function edgeFetch(
    host: string,
    urlPath: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<EdgeResponse> {
    const res = await fetch(`${edge.edgeUrl}${urlPath}`, {
      method: init?.method ?? "GET",
      headers: { ...(init?.headers ?? {}), "x-verify-host": host },
      ...(init?.body !== undefined ? { body: init.body } : {}),
      redirect: "manual",
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return { status: res.status, headers, body: await res.text() };
  }

  return {
    baseDomain,
    controlHost,
    expectedMemoryBytes: 512 * 1024 * 1024,
    async deployFixture(kind) {
      const slug = `vfy-${kind}-${suffix}`;
      let record: DeployedFixture;
      if (kind === "node") {
        record = await createAndDeploy(kind, slug, {
          repo: repoUrls.node,
          branch: "main",
          port: 3000,
        });
      } else if (kind === "python") {
        record = await createAndDeploy(kind, slug, {
          repo: repoUrls.python,
          branch: "main",
          port: 8000,
        });
      } else if (kind === "dockerfile") {
        record = await createAndDeploy(kind, slug, {
          repo: repoUrls.dockerfile,
          branch: "main",
          port: 3000,
          healthPath: "/health",
          env: { RELEASE_VERSION: "v1" },
        });
      } else {
        const image = process.env["VERIFY_IMAGE_FIXTURE"] ?? "nginxinc/nginx-unprivileged:alpine";
        record = await createAndDeploy(kind, slug, {
          source: { type: "image", image },
          port: 8080,
        });
      }
      deployed.set(kind, record);
      return record;
    },
    getFixture(kind) {
      return deployed.get(kind);
    },
    edgeFetch,
    async probeContainerEgress(containerName): Promise<EgressProbeResult> {
      async function probeTarget(bindHost: string, targetHost: string): Promise<boolean> {
        let hits = 0;
        const srv = net.createServer((s) => {
          hits++;
          s.destroy();
        });
        await new Promise<void>((r) => srv.listen(0, bindHost, r));
        const port = (srv.address() as net.AddressInfo).port;
        try {
          const script =
            'const net = require("node:net");' +
            `const s = net.connect({ host: ${JSON.stringify(targetHost)}, port: ${port}, timeout: 1500 });` +
            's.on("connect", () => { s.end("hi"); });' +
            's.on("error", () => process.exit(0));' +
            "setTimeout(() => process.exit(0), 1500);";
          await runDocker(dockerEnv, ["exec", containerName, "node", "-e", script], 10_000);
        } finally {
          srv.close();
        }
        return hits > 0;
      }

      const loopbackReached = await probeTarget("127.0.0.1", "10.0.2.2");
      const lanAddresses = Object.values(os.networkInterfaces())
        .flat()
        .filter((i): i is os.NetworkInterfaceInfo => Boolean(i))
        .filter((i) => i.family === "IPv4" && !i.internal)
        .map((i) => i.address);
      const reachedLan: string[] = [];
      for (const addr of lanAddresses) {
        if (await probeTarget("0.0.0.0", addr)) reachedLan.push(addr);
      }
      return {
        loopbackReached,
        lanReached: reachedLan.length > 0,
        lanTargets: reachedLan.length > 0 ? reachedLan : lanAddresses,
      };
    },
    async inspectContainerCaps(containerName): Promise<ContainerCapsResult> {
      const mem = await runDocker(dockerEnv, [
        "exec",
        containerName,
        "cat",
        "/sys/fs/cgroup/memory.max",
      ]);
      const parsedMem = Number.parseInt(mem.stdout.trim(), 10);
      const logRes = await runDocker(dockerEnv, [
        "inspect",
        "--format",
        "{{json .HostConfig.LogConfig}}",
        containerName,
      ]);
      let cfg: { Type?: string; Config?: Record<string, string> } = {};
      try {
        cfg = JSON.parse(logRes.stdout) as { Type?: string; Config?: Record<string, string> };
      } catch {
        /* leave empty */
      }
      return {
        memoryMaxBytes: Number.isFinite(parsedMem) ? parsedMem : null,
        logDriver: cfg.Type ?? "",
        logMaxSize: cfg.Config?.["max-size"] ?? "",
        logMaxFile: cfg.Config?.["max-file"] ?? "",
        logCompress: cfg.Config?.["compress"] ?? "",
      };
    },
    async exerciseReleaseLifecycle(fixture): Promise<ReleaseExerciseOutcome> {
      await api("PUT", `/api/projects/${fixture.projectId}/env`, {
        env: { RELEASE_VERSION: "v2" },
      });

      let inFlightTotal = 0;
      let inFlightFailed = 0;
      let stopLoad = false;
      const loadLoop = (async () => {
        while (!stopLoad) {
          const r = await edgeFetch(fixture.host, "/");
          inFlightTotal++;
          if (r.status !== 200) inFlightFailed++;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })();

      const v2Start = await api("POST", `/api/projects/${fixture.projectId}/deploy`, {});
      const v2Outcome = await waitForDeployment(v2Start.body.deployment.id as string);
      stopLoad = true;
      await loadLoop;
      if (v2Outcome.status !== "live") {
        throw new Error(`v2 redeploy failed:\n${v2Outcome.logs.join("\n")}`);
      }
      const afterV2 = JSON.parse((await edgeFetch(fixture.host, "/")).body) as { version?: string };

      await api("PUT", `/api/projects/${fixture.projectId}/env`, {
        env: { RELEASE_VERSION: "v3", FAIL_HEALTH: "true" },
      });
      const badStart = await api("POST", `/api/projects/${fixture.projectId}/deploy`, {});
      const badOutcome = await waitForDeployment(badStart.body.deployment.id as string);
      const duringBad = JSON.parse((await edgeFetch(fixture.host, "/")).body) as {
        version?: string;
      };

      await api("PUT", `/api/projects/${fixture.projectId}/env`, {
        env: { RELEASE_VERSION: "v1" },
      });
      const rbStart = await api("POST", `/api/deployments/${fixture.firstDeploymentId}/rollback`);
      const rbOutcome = await waitForDeployment(rbStart.body.deployment.id as string);
      if (rbOutcome.status !== "live") {
        throw new Error(`rollback failed:\n${rbOutcome.logs.join("\n")}`);
      }
      const afterRb = JSON.parse((await edgeFetch(fixture.host, "/")).body) as { version?: string };

      const refreshed = await api("GET", `/api/projects/${fixture.projectId}`);
      fixture.containerName = refreshed.body.project.containerName as string;

      return {
        inFlightTotal,
        inFlightFailed,
        upgradedVersion: afterV2.version ?? "",
        unhealthyDeploymentStatus: badOutcome.status,
        versionDuringUnhealthy: duringBad.version ?? "",
        rolledBackVersion: afterRb.version ?? "",
      };
    },
    async exerciseVolumePersistence(): Promise<VolumeExerciseOutcome> {
      const slug = `vfy-vol-${suffix}`;
      const volumeName = `nexus-vol-${slug}`;
      const project = await createAndDeploy(
        "dockerfile",
        slug,
        {
          repo: repoUrls.dockerfile,
          branch: "main",
          port: 3000,
          volumePath: "/data",
          healthPath: "/health",
          env: { RELEASE_VERSION: "v1" },
        },
        volumeName,
      );
      const writtenMarker = `volume-marker-${Date.now()}`;
      const writeRes = await edgeFetch(project.host, "/volume", {
        method: "POST",
        body: writtenMarker,
      });
      if (writeRes.status !== 200) {
        throw new Error(`POST /volume failed with HTTP ${writeRes.status}`);
      }

      await api("PUT", `/api/projects/${project.projectId}/env`, {
        env: { RELEASE_VERSION: "v2" },
      });
      const redeploy = await api("POST", `/api/projects/${project.projectId}/deploy`, {});
      const outcome = await waitForDeployment(redeploy.body.deployment.id as string);
      if (outcome.status !== "live") {
        throw new Error(`volume redeploy failed:\n${outcome.logs.join("\n")}`);
      }
      const refreshed = await api("GET", `/api/projects/${project.projectId}`);
      project.containerName = refreshed.body.project.containerName as string;

      const readRes = await edgeFetch(project.host, "/volume");
      const parsed = JSON.parse(readRes.body) as { value?: string; version?: string };
      return {
        project,
        writtenMarker,
        readAfterRedeploy: parsed.value ?? "",
        versionAfterRedeploy: parsed.version ?? "",
      };
    },
    async deleteAllFixturesAndVerify(): Promise<CleanupCheckOutcome> {
      const remainingContainers: string[] = [];
      const remainingRoutes: string[] = [];
      const remainingSlugs: string[] = [];
      const remainingVolumes: string[] = [];

      for (const f of allProjects) {
        const del = await api("DELETE", `/api/projects/${f.projectId}`);
        if (del.status !== 200) {
          throw new Error(`DELETE /api/projects/${f.projectId} returned ${del.status}`);
        }
        const inspect = await runDocker(dockerEnv, ["inspect", f.containerName]);
        if (inspect.code === 0) remainingContainers.push(f.containerName);

        const routeRes = await edgeFetch(f.host, "/");
        if (routeRes.status !== 404) remainingRoutes.push(f.host);

        if (await cloudNameTaken(cloudSettings, f.slug)) {
          remainingSlugs.push(f.slug);
        }
        if (f.volumeName) {
          const volInspect = await runDocker(dockerEnv, ["volume", "inspect", f.volumeName]);
          if (volInspect.code === 0) remainingVolumes.push(f.volumeName);
        }
      }
      return { remainingContainers, remainingRoutes, remainingSlugs, remainingVolumes };
    },
    async cleanup() {
      publisher.stop();
      for (const f of allProjects) {
        await runDocker(dockerEnv, ["rm", "-f", f.containerName]).catch(() => {});
        if (f.volumeName) {
          await runDocker(dockerEnv, ["volume", "rm", "-f", f.volumeName]).catch(() => {});
        }
      }
      const imgs = await runDocker(dockerEnv, ["images", "--format", "{{.Repository}}:{{.Tag}}"]);
      for (const ref of imgs.stdout.split("\n").map((s) => s.trim())) {
        if (ref.startsWith("nexus/vfy-") && ref.includes(suffix)) {
          await runDocker(dockerEnv, ["rmi", "-f", ref]).catch(() => {});
        }
      }
      await new Promise<void>((r) => deployServer.close(() => r()));
      await edge.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}
