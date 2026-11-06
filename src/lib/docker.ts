import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { toEnvFile } from "./env.js";
import { buildRunArgs } from "./run-args.js";
import type { ContainerLimits } from "./safeguards.js";

export type LogLine = (line: string) => void;

/** Thrown instead of ever running a build or a container on the host's own Docker. */
export class SandboxNotConfigured extends Error {
  constructor() {
    super(
      "The build sandbox is not configured (SANDBOX_DOCKER_HOST is empty). "
        + "Refusing to use the host's Docker daemon.",
    );
    this.name = "SandboxNotConfigured";
  }
}

const SANDBOXED_COMMANDS = new Set(["docker", "nixpacks"]);

/**
 * Environment for a child process. Docker and the builder are pointed at the
 * sandbox daemon and nothing else: DOCKER_HOST is forced and any DOCKER_CONTEXT
 * the operator happens to have set is dropped, so no ambient setting can send a
 * member's build to the host daemon. With no sandbox configured they do not run.
 */
export function childEnv(
  cmd: string,
  sandboxHost: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!SANDBOXED_COMMANDS.has(cmd)) return base;
  if (!sandboxHost) throw new SandboxNotConfigured();
  const env: NodeJS.ProcessEnv = { ...base, DOCKER_HOST: sandboxHost };
  delete env["DOCKER_CONTEXT"];
  delete env["DOCKER_TLS_VERIFY"];
  delete env["DOCKER_CERT_PATH"];
  return env;
}

export type SpawnOptions = { env?: Record<string, string>; timeoutMs?: number };

/** Stream a command's stdout/stderr line-by-line. Resolves on exit code 0. */
export function spawnStream(
  cmd: string,
  args: string[],
  onLine: LogLine,
  cwd?: string,
  opts: SpawnOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...childEnv(cmd, config.sandboxDockerHost), ...opts.env },
    });
    const timeoutMs = opts.timeoutMs;
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGKILL");
        }, timeoutMs)
      : undefined;
    proc.stdout.on("data", (buf: Buffer) =>
      buf.toString().split("\n").filter(Boolean).forEach(onLine)
    );
    proc.stderr.on("data", (buf: Buffer) =>
      buf.toString().split("\n").filter(Boolean).forEach(onLine)
    );
    proc.on("close", code => {
      if (timer) clearTimeout(timer);
      if (timedOut) reject(new Error(`${cmd} timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s`));
      else if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    proc.on("error", err => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Spawn a long-running streaming process (e.g. docker logs -f).
 * Returns a kill() function — call it when the consumer is done.
 */
export function spawnStreaming(
  cmd: string,
  args: string[],
  onLine: LogLine,
  onEnd?: (err?: Error) => void,
  opts: SpawnOptions = {},
): () => void {
  let proc: ChildProcess;
  try {
    proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...childEnv(cmd, config.sandboxDockerHost), ...opts.env },
    });
  } catch (err) {
    onEnd?.(err as Error);
    return () => {};
  }

  proc.stdout!.on("data", (buf: Buffer) =>
    buf.toString().split("\n").filter(Boolean).forEach(onLine)
  );
  proc.stderr!.on("data", (buf: Buffer) =>
    buf.toString().split("\n").filter(Boolean).forEach(onLine)
  );

  proc.on("close", (code) => {
    if (onEnd) onEnd(code !== 0 ? new Error(`exited ${code}`) : undefined);
  });
  proc.on("error", (err) => { if (onEnd) onEnd(err); });

  return () => {
    try { proc.kill("SIGTERM"); } catch {}
  };
}

// ── docker run ─────────────────────────────────────────────────────────────
export async function dockerRun(opts: {
  image: string;
  name: string;
  env: Record<string, string>;
  domain: string;
  port: number;
  network: string;
  onLine: LogLine;
  volumes?: string[];       // ["host:container", ...]
  memoryLimit?: string;     // e.g. "512m", "1g"
  cpus?: string;            // e.g. "0.5", "2"
}): Promise<string> {
  const { image, name, env, domain, port, network, onLine, volumes = [], memoryLimit, cpus } = opts;

  await spawnStream("docker", ["rm", "-f", name], () => {}).catch(() => {});

  const envFlags   = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const volFlags   = volumes.flatMap(v => ["-v", v]);
  const limitFlags = [
    ...(memoryLimit ? ["--memory", memoryLimit] : []),
    ...(cpus        ? ["--cpus",   cpus]        : []),
  ];

  const labels = [
    `traefik.enable=true`,
    `traefik.http.routers.${name}.rule=Host(\`${domain}\`)`,
    `traefik.http.routers.${name}.tls=true`,
    `traefik.http.routers.${name}.tls.certresolver=letsencrypt`,
    `traefik.http.services.${name}.loadbalancer.server.port=${port}`,
  ];
  const labelFlags = labels.flatMap(l => ["-l", l]);

  const args = [
    "run", "-d",
    "--name", name,
    "--network", network,
    "--restart", "unless-stopped",
    ...envFlags,
    ...volFlags,
    ...limitFlags,
    ...labelFlags,
    image,
  ];

  let containerId = "";
  await spawnStream("docker", args, line => {
    containerId = line.trim();
    onLine(`[nexus] Container started: ${line.trim().slice(0, 12)}`);
  });
  return containerId;
}

// ── docker stop / start / restart / remove ─────────────────────────────────
export async function dockerStop(name: string)    { await spawnStream("docker", ["stop",    name], () => {}).catch(() => {}); }
export async function dockerStart(name: string)   { await spawnStream("docker", ["start",   name], () => {}).catch(() => {}); }
export async function dockerRestart(name: string) { await spawnStream("docker", ["restart", name], () => {}).catch(() => {}); }
export async function dockerRemove(name: string)  { await spawnStream("docker", ["rm", "-f", name], () => {}).catch(() => {}); }

// ── Where to reach a container from this process ──────────────────────────
// On the host network the app listens on the host's loopback; on a bridge
// network it has its own address on that network, reachable from the host.
export async function dockerContainerHost(name: string, network: string): Promise<string | null> {
  if (network === "host") return "127.0.0.1";
  let out = "";
  // spawnStream merges stderr into the lines, so only trust output on success.
  return spawnStream("docker", ["inspect", "-f", `{{with index .NetworkSettings.Networks "${network}"}}{{.IPAddress}}{{end}}`, name], l => { out = l; })
    .then(() => out.trim() || null, () => null);
}

/** Last lines of a container's output, for the deployment log when it fails. */
export async function dockerLogTail(name: string, lines = 20): Promise<string[]> {
  const out: string[] = [];
  await spawnStream("docker", ["logs", "--tail", String(lines), name], l => { out.push(l); }).catch(() => {});
  return out;
}

// ── docker inspect (status) ────────────────────────────────────────────────
export async function dockerStatus(name: string): Promise<string> {
  return new Promise(resolve => {
    let out = "";
    spawnStream("docker", ["inspect", "-f", "{{.State.Status}}", name], l => { out = l; })
      .then(() => resolve(out.trim()))
      .catch(() => resolve("missing"));
  });
}

// ── docker stats (one-shot) ────────────────────────────────────────────────
export type ContainerStats = {
  cpu: string;
  memUsage: string;
  memLimit: string;
  memPercent: string;
  netIn: string;
  netOut: string;
  pids: string;
};

export async function dockerStats(name: string): Promise<ContainerStats | null> {
  return new Promise(resolve => {
    let out = "";
    const fmt = "{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.PIDs}}";
    spawnStream("docker", ["stats", "--no-stream", "--format", fmt, name], l => { out = l; })
      .then(() => {
        if (!out.trim()) { resolve(null); return; }
        const [cpu, memUsage, memPercent, netIO, pids] = out.split("\t");
        const [netIn, netOut] = (netIO ?? "").split(" / ");
        const [memUse, memLim] = (memUsage ?? "").split(" / ");
        resolve({ cpu: cpu?.trim() ?? "—", memUsage: memUse?.trim() ?? "—", memLimit: memLim?.trim() ?? "—", memPercent: memPercent?.trim() ?? "—", netIn: netIn?.trim() ?? "—", netOut: netOut?.trim() ?? "—", pids: pids?.trim() ?? "—" });
      })
      .catch(() => resolve(null));
  });
}

// ── docker logs (streaming — returns kill fn) ──────────────────────────────
export function dockerLogs(name: string, onLine: LogLine, onEnd?: (err?: Error) => void): () => void {
  return spawnStreaming("docker", ["logs", "--tail", "100", "-f", name], onLine, onEnd);
}

// ── Hardened run (the only way an app container is started) ───────────────
export async function dockerRunHardened(opts: {
  name: string;
  image: string;
  env: Record<string, string>;
  appPort: number;
  hostPort: number;
  limits: ContainerLimits;
  volume?: { name: string; path: string } | undefined;
  onLine: LogLine;
}): Promise<string> {
  await spawnStream("docker", ["rm", "-f", opts.name], () => {}).catch(() => {});

  // The environment goes in a 0600 file, not on the command line where `ps` shows it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-env-"));
  const envFile = path.join(dir, "env");
  fs.writeFileSync(envFile, toEnvFile(opts.env), { mode: 0o600 });
  try {
    let containerId = "";
    await spawnStream(
      "docker",
      buildRunArgs({
        name: opts.name,
        image: opts.image,
        appPort: opts.appPort,
        hostPort: opts.hostPort,
        envFile,
        volume: opts.volume,
        limits: opts.limits,
      }),
      line => {
        containerId = line.trim();
        opts.onLine(`[nexus] Container started: ${containerId.slice(0, 12)}`);
      },
    );
    return containerId;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Images ─────────────────────────────────────────────────────────────────
export function parseRepoDigest(line: string): string | null {
  return /@(sha256:[a-f0-9]{64})/.exec(line)?.[1] ?? null;
}

/** The content digest of a pulled image, or null for one built locally. */
export async function dockerImageDigest(image: string): Promise<string | null> {
  const lines: string[] = [];
  await spawnStream(
    "docker",
    ["image", "inspect", "-f", "{{range .RepoDigests}}{{println .}}{{end}}", image],
    l => lines.push(l),
  ).catch(() => {});
  for (const line of lines) {
    const digest = parseRepoDigest(line);
    if (digest) return digest;
  }
  return null;
}

/** Pull an image and return its digest, so a release can be pinned to exact bytes. */
export async function dockerPull(image: string, onLine: LogLine, timeoutMs: number): Promise<string> {
  await spawnStream("docker", ["pull", image], onLine, undefined, { timeoutMs });
  const digest = await dockerImageDigest(image);
  if (!digest) throw new Error("pulled the image but could not read its digest");
  return digest;
}

export type ListedImage = { repository: string; tag: string; digest: string; id: string };

/** Parses `docker images --digests --format "{{.Repository}}\t{{.Tag}}\t{{.Digest}}\t{{.ID}}"`. */
export function parseImageList(lines: readonly string[]): ListedImage[] {
  const out: ListedImage[] = [];
  for (const line of lines) {
    const [repository, tag, digest, id] = line.split("\t");
    if (repository !== undefined && tag !== undefined && digest !== undefined && id) {
      out.push({ repository, tag, digest, id });
    }
  }
  return out;
}

/** Every image in the sandbox daemon. It is dedicated to Deploy, so all of them are ours. */
export async function dockerListImages(): Promise<ListedImage[]> {
  const lines: string[] = [];
  await spawnStream(
    "docker",
    ["images", "--digests", "--format", "{{.Repository}}\t{{.Tag}}\t{{.Digest}}\t{{.ID}}"],
    l => lines.push(l),
  ).catch(() => {});
  return parseImageList(lines);
}

/** Never forced: Docker itself refuses to remove an image a container still uses. */
export async function dockerRemoveImage(ref: string): Promise<boolean> {
  return spawnStream("docker", ["rmi", ref], () => {}).then(() => true, () => false);
}

export async function dockerRemoveVolume(name: string): Promise<void> {
  await spawnStream("docker", ["volume", "rm", "-f", name], () => {}).catch(() => {});
}
