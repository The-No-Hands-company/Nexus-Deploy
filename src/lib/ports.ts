/**
 * Loopback ports for apps.
 *
 * Each running app is published on 127.0.0.1:<port> and the ingress reaches it
 * only there. A blue/green release needs a second port while the first is still
 * serving, so ports are handed out one release at a time and the caller says
 * which are already in use.
 */
import net from "node:net";
import type { PortRange } from "./hosts.js";

/**
 * First free port in `range` not in `used`, scanning from `start` and wrapping.
 * `isFree` asks the operating system, because something outside Deploy may hold
 * a port in the range. Returns null when the whole range is taken.
 */
export async function allocatePort(
  range: PortRange,
  used: ReadonlySet<number>,
  isFree: (port: number) => Promise<boolean>,
  start: number = Math.floor(Math.random() * (range.max - range.min + 1)),
): Promise<number | null> {
  const size = range.max - range.min + 1;
  for (let step = 0; step < size; step++) {
    const port = range.min + ((start + step) % size);
    if (used.has(port)) continue;
    if (await isFree(port)) return port;
  }
  return null;
}

/** True when nothing is listening on 127.0.0.1:<port>. */
export function loopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** Every port a project currently holds or has reserved for a release in progress. */
export function portsInUse(
  projects: ReadonlyArray<{ hostPort?: number | undefined; pendingPort?: number | undefined }>,
): Set<number> {
  const used = new Set<number>();
  for (const project of projects) {
    if (project.hostPort !== undefined) used.add(project.hostPort);
    if (project.pendingPort !== undefined) used.add(project.pendingPort);
  }
  return used;
}
