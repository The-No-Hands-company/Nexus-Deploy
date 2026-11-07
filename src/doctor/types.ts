import type { ContainerLimits } from "../lib/safeguards.js";

export type Status = "pass" | "warn" | "fail" | "skip";

export type CheckResult = {
  id: string;
  title: string;
  status: Status;
  detail: string;
  /** What to do about a warning or failure. */
  fix?: string;
};

export type DockerResult = { code: number; stdout: string; stderr: string };

/** A TCP listener the doctor opens, to see whether a container can reach it. */
export type Listener = {
  port: number;
  /** How many connections it has accepted so far. */
  accepted(): number;
  close(): void;
};

/**
 * Everything a check needs from the outside world, so each check is a plain
 * function of this and can be tested against a fake without Docker or a disk.
 */
export type Ctx = {
  /** SANDBOX_DOCKER_HOST, e.g. unix:///run/nexus-deploy-sandbox/docker.sock. Empty when unset. */
  sandboxHost: string;
  /** SANDBOX_STORAGE_PATH. Empty when unset. */
  storagePath: string;
  /** SANDBOX_STORAGE_SIZE_GB, or 0 when unknown. */
  expectedStorageGb: number;
  limits: ContainerLimits;
  /** A tiny image the probes run; pulled once if absent. */
  probeImage: string;
  /** Run the docker CLI against the sandbox daemon, and nothing else. */
  docker(args: string[], timeoutMs?: number): Promise<DockerResult>;
  fileExists(path: string): boolean;
  /** The device number of the filesystem holding `path`, or null if it does not exist. */
  device(path: string): number | null;
  fsUsage(path: string): { totalBytes: number; freeBytes: number } | null;
  /** The host's non-loopback IPv4 addresses. */
  hostAddresses(): string[];
  listen(host: string): Promise<Listener>;
};

export type Check = {
  id: string;
  title: string;
  /** Ids that must have passed for this one to mean anything; otherwise it is skipped. */
  needs?: string[];
  run(ctx: Ctx): Promise<Omit<CheckResult, "id" | "title">>;
};
