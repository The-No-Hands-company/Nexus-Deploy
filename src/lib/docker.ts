import { spawn, type ChildProcess } from "node:child_process";

export type LogLine = (line: string) => void;

/** Stream a command's stdout/stderr line-by-line. Resolves on exit code 0. */
export function spawnStream(
  cmd: string,
  args: string[],
  onLine: LogLine,
  cwd?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (buf: Buffer) =>
      buf.toString().split("\n").filter(Boolean).forEach(onLine)
    );
    proc.stderr.on("data", (buf: Buffer) =>
      buf.toString().split("\n").filter(Boolean).forEach(onLine)
    );
    proc.on("close", code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
    proc.on("error", reject);
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
  onEnd?: (err?: Error) => void
): () => void {
  const proc: ChildProcess = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

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
