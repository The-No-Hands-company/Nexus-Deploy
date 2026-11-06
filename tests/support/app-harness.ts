/**
 * Starts the real HTTP app on an ephemeral port with every outside dependency
 * faked: identity, Docker, the build pipeline, the ingress. Importing this file
 * points the data directory at a throwaway folder first, so it must be imported
 * before anything that reads the config (node --test gives each test file its
 * own process, so nothing leaks between files).
 */
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LIMITS, type Verdict } from "../../src/lib/safeguards.js";
import type { Authenticator, NexusIdentity } from "../../src/middleware/auth.js";
import type { AppDeps, Pipeline, ProjectOps } from "../../src/routes/types.js";
import type { DeployTrigger, Deployment, Project } from "../../src/types.js";
import { RecordingPublisher } from "./fakes.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-routes-"));
process.env["DATA_DIR"] = dataDir;
process.env["APP_SECRET"] = "test-secret-test-secret-1234";
process.env["BASE_DOMAIN"] = "example.test";
process.env["SANDBOX_DOCKER_HOST"] = "unix:///does-not-exist.sock";

export const store = await import("../../src/lib/store.js");
const { createApp } = await import("../../src/app.js");
const { attachSockets } = await import("../../src/lib/ws.js");

export const IDENTITIES: Record<string, NexusIdentity> = {
  "t-boss": { id: "boss", role: "founder", username: "boss" },
  "t-admin": { id: "adm", role: "admin", username: "adm" },
  "t-ada": { id: "ada", role: "user", username: "ada" },
  "t-bob": { id: "bob", role: "user", username: "bob" },
  "t-cy": { id: "cy", role: "user", username: "cy" },
};

export const fakeAuth: Authenticator = async (token) => {
  if (token === "t-down") return { kind: "unavailable" };
  const identity = IDENTITIES[token];
  return identity ? { kind: "ok", identity } : { kind: "denied" };
};

/** Insert a project directly, for tests that start from a project in a given state. */
export function addProject(patch: Partial<import("../../src/types.js").Project> = {}) {
  const project = {
    id: `prj_${Math.random().toString(36).slice(2, 10)}`,
    ownerId: "ada",
    name: "demo",
    repo: "o/r",
    branch: "main",
    buildContext: ".",
    buildCommand: "",
    startCommand: "",
    volumePath: "/workspace",
    port: 3000,
    env: {},
    status: "idle",
    autoDeployEnabled: true,
    webhookSecret: "whsec_test_secret",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  } as import("../../src/types.js").Project;
  const db = store.loadDb();
  db.projects.unshift(project);
  store.saveDb(db);
  return project;
}

export function addDeployment(
  patch: Partial<import("../../src/types.js").Deployment> & { projectId: string },
) {
  const dep = {
    id: `dep_${Math.random().toString(36).slice(2, 12)}`,
    commitSha: "abc12345",
    triggeredBy: "manual",
    status: "live",
    imageTag: "nexus/demo:old",
    logs: ["[nexus] hello"],
    createdAt: 1,
    ...patch,
  } as import("../../src/types.js").Deployment;
  const db = store.loadDb();
  db.deployments.unshift(dep);
  store.saveDb(db);
  return dep;
}

export function resetDb(): void {
  store.saveDb({ users: [], projects: [], deployments: [], sessions: [], members: [], audit: [] });
}

export class FakePipeline implements Pipeline {
  readonly deploys: Array<{ projectId: string; deploymentId: string }> = [];
  readonly rollbacks: Array<{ projectId: string; deploymentId: string; imageRef: string }> = [];
  readonly cancelled: string[] = [];
  verdict: Verdict = { ok: true };
  building = new Set<string>();
  cancellable = true;

  createDeployment(project: Project, commitSha: string, trigger: DeployTrigger): Deployment {
    const dep: Deployment = {
      id: `dep_${store.loadDb().deployments.length + 1}`.padEnd(20, "0"),
      projectId: project.id,
      commitSha,
      triggeredBy: trigger,
      status: "queued",
      imageTag: "",
      logs: [`[nexus] Deploy queued → ${project.name}`],
      createdAt: Date.now(),
    };
    const db = store.loadDb();
    db.deployments.unshift(dep);
    store.saveDb(db);
    return dep;
  }
  async runDeploy(project: Project, deploymentId: string): Promise<void> {
    this.deploys.push({ projectId: project.id, deploymentId });
  }
  async runRollback(project: Project, deploymentId: string, imageRef: string): Promise<void> {
    this.rollbacks.push({ projectId: project.id, deploymentId, imageRef });
  }
  isBuilding(projectId: string): boolean {
    return this.building.has(projectId);
  }
  async cancelBuild(deploymentId: string): Promise<boolean> {
    this.cancelled.push(deploymentId);
    return this.cancellable;
  }
  guardBuild(): Verdict {
    return this.verdict;
  }
}

export class FakeOps implements ProjectOps {
  readonly calls: string[] = [];
  statusValue = "running";
  logLines: string[] = [];
  async stop(name: string) {
    this.calls.push(`stop:${name}`);
  }
  async start(name: string) {
    this.calls.push(`start:${name}`);
  }
  async restart(name: string) {
    this.calls.push(`restart:${name}`);
  }
  async remove(name: string) {
    this.calls.push(`remove:${name}`);
  }
  async status(name: string) {
    this.calls.push(`status:${name}`);
    return this.statusValue;
  }
  async stats(name: string) {
    this.calls.push(`stats:${name}`);
    return {
      cpu: "1%",
      memUsage: "10MiB",
      memLimit: "512MiB",
      memPercent: "2%",
      netIn: "1kB",
      netOut: "1kB",
      pids: "3",
    };
  }
  logs(name: string, onLine: (line: string) => void, onEnd?: (err?: Error) => void): () => void {
    this.calls.push(`logs:${name}`);
    for (const line of this.logLines) onLine(line);
    onEnd?.();
    return () => {};
  }
  async removeVolume(name: string) {
    this.calls.push(`removeVolume:${name}`);
  }
  async removeImage(ref: string) {
    this.calls.push(`removeImage:${ref}`);
    return true;
  }
}

export type CallOptions = {
  token?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
};
// biome-ignore lint/suspicious/noExplicitAny: a test helper that returns parsed JSON of any shape
export type CallResult = { status: number; body: any; headers: Headers };

export async function startHarness(patch: Partial<AppDeps> = {}) {
  const pipeline = new FakePipeline();
  const ops = new FakeOps();
  const publisher = new RecordingPublisher();
  let clock = 1_800_000_000_000;
  const deps: AppDeps = {
    authenticate: fakeAuth,
    pipeline,
    ops,
    publisher,
    takenElsewhere: async () => false,
    limits: DEFAULT_LIMITS,
    allowLocalRepos: false,
    now: () => clock,
    node: {
      baseDomain: "example.test",
      controlHost: "deploy.example.test",
      hostPattern: "{slug}.{BASE_DOMAIN}",
    },
    version: "test",
    staticDir: null,
    ...patch,
  };
  const server: Server = createApp(deps).listen(0, "127.0.0.1");
  attachSockets(server, deps);
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(
    method: string,
    route: string,
    options: CallOptions = {},
  ): Promise<CallResult> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
    let body: string | undefined;
    if (options.rawBody !== undefined) body = options.rawBody;
    else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["Content-Type"] ??= "application/json";
    }
    const response = await fetch(`${url}${route}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const text = await response.text();
    // biome-ignore lint/suspicious/noExplicitAny: parsed JSON of any shape
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON: leave as text */
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  return {
    url,
    call,
    deps,
    pipeline,
    ops,
    publisher,
    advance: (ms: number) => {
      clock += ms;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
