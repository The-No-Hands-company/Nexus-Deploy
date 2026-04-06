import { spawn } from "node:child_process";

export type LogLine = (line: string) => void;

/** Stream a command's stdout/stderr line-by-line, resolving when done */
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

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

export async function dockerRun(opts: {
  image: string;
  name: string;
  env: Record<string, string>;
  domain: string;
  port: number;
  network: string;
  onLine: LogLine;
}): Promise<string> {
  const { image, name, env, domain, port, network, onLine } = opts;

  // Remove old container if it exists
  await spawnStream("docker", ["rm", "-f", name], () => {}).catch(() => {});

  const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

  const labels = [
    `traefik.enable=true`,
    `traefik.http.routers.${name}.rule=Host(\`${domain}\`)`,
    `traefik.http.routers.${name}.tls=true`,
    `traefik.http.routers.${name}.tls.certresolver=letsencrypt`,
    `traefik.http.services.${name}.loadbalancer.server.port=${port}`,
  ];
  const labelFlags = labels.flatMap((l) => ["-l", l]);

  const args = [
    "run", "-d",
    "--name", name,
    "--network", network,
    "--restart", "unless-stopped",
    ...envFlags,
    ...labelFlags,
    image,
  ];

  let containerId = "";
  await spawnStream("docker", args, (line) => {
    containerId = line.trim();
    onLine(`[nexus] Container started: ${line.trim().slice(0, 12)}`);
  });
  return containerId;
}

export async function dockerStop(name: string): Promise<void> {
  await spawnStream("docker", ["stop", name], () => {}).catch(() => {});
}

export async function dockerStart(name: string): Promise<void> {
  await spawnStream("docker", ["start", name], () => {}).catch(() => {});
}

export async function dockerRemove(name: string): Promise<void> {
  await spawnStream("docker", ["rm", "-f", name], () => {}).catch(() => {});
}

export async function dockerStatus(name: string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    spawnStream("docker", ["inspect", "-f", "{{.State.Status}}", name], (l) => { out = l; })
      .then(() => resolve(out.trim()))
      .catch(() => resolve("missing"));
  });
}

export async function dockerLogs(name: string, onLine: LogLine): Promise<void> {
  await spawnStream("docker", ["logs", "--tail", "100", "-f", name], onLine).catch(() => {});
}
