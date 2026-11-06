/**
 * The exact `docker run` arguments for a member's app.
 *
 * This is the container boundary, so it is a pure function with tests that read
 * the result: every flag that makes the container safe is asserted there. The
 * container gets no capabilities and no way to gain any, hard CPU/memory/process
 * caps, a loopback-only published port, size-capped logs, and nothing from the
 * host except its own named volume.
 */
import type { ContainerLimits } from "./safeguards.js";

export type RunSpec = {
  name: string;
  image: string;
  /** Port the app listens on inside the container. */
  appPort: number;
  /** Port on the host's loopback it is published on. */
  hostPort: number;
  /** Path of a 0600 file of NAME=value lines (kept off the command line). */
  envFile: string;
  volume?: { name: string; path: string } | undefined;
  limits: ContainerLimits;
};

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,100}$/;
const VOLUME_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,100}$/;
const VOLUME_PATH_RE = /^\/[A-Za-z0-9._/-]{0,200}$/;

export function validateVolumePath(path: unknown): string {
  if (typeof path !== "string" || !VOLUME_PATH_RE.test(path) || path.split("/").includes("..")) {
    throw new Error("volumePath must be an absolute path such as /data");
  }
  return path;
}

export function buildRunArgs(spec: RunSpec): string[] {
  if (!NAME_RE.test(spec.name)) throw new Error(`unsafe container name: ${spec.name}`);
  if (spec.volume) {
    if (!VOLUME_NAME_RE.test(spec.volume.name)) throw new Error(`unsafe volume name: ${spec.volume.name}`);
    validateVolumePath(spec.volume.path);
  }
  return [
    "run",
    "-d",
    "--name",
    spec.name,
    "--restart",
    "unless-stopped",
    // No capabilities, and no way to acquire any (setuid binaries included).
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(spec.limits.pids),
    // Swap equal to memory means no swap at all.
    "--memory",
    spec.limits.memory,
    "--memory-swap",
    spec.limits.memory,
    "--cpus",
    spec.limits.cpus,
    // Docker's default driver keeps logs forever. These are capped, and the
    // charter promises we keep nothing longer than we need.
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=10m",
    "--log-opt",
    "max-file=2",
    "--log-opt",
    "compress=false",
    // Reachable from the ingress on loopback only; never on a public interface.
    "-p",
    `127.0.0.1:${spec.hostPort}:${spec.appPort}`,
    "--env-file",
    spec.envFile,
    ...(spec.volume ? ["-v", `${spec.volume.name}:${spec.volume.path}`] : []),
    // Lets the hourly prune recognise images and containers this service made.
    "-l",
    "nexus.managed=true",
    spec.image,
  ];
}
