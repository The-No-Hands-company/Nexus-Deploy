import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitSource } from "../types.js";
/**
 * The three things a deployment actually does to the outside world: clone a
 * repository, build an image, pull an image. They are separate from the
 * pipeline in build.ts so the pipeline can be tested with fakes, and because
 * each is only a thin, easily-read wrapper around one command.
 *
 * When a repository has no Dockerfile, Railpack prepares a BuildKit plan in a
 * throwaway directory outside the build context and `docker build` executes it
 * against the sandbox daemon via its built-in BuildKit frontend.
 *
 * Each step settles when its process ends. Cancelling kills the process, which
 * makes the step reject; build.ts then reads its own flags to say *why*.
 */
import { type LogLine, dockerPull, spawnStreaming } from "./docker.js";
import { resolveRepoUrl } from "./repo.js";
import { gitCredentialEnv } from "./source.js";

export const RAILPACK_VERSION = "0.43.0";
export const RAILPACK_FRONTEND = `ghcr.io/railwayapp/railpack-frontend:v${RAILPACK_VERSION}`;

/** Registers a way to stop the running step. */
export type Track = (kill: () => void) => void;

export type BuildOptions = {
  contextDir: string;
  /** Resolved Dockerfile path, or null to let Railpack work out the stack. */
  dockerfile: string | null;
  tag: string;
  buildCommand?: string;
  startCommand?: string;
};

export type StepRunner = (
  cmd: string,
  args: string[],
  log: LogLine,
  track: Track,
  env?: Record<string, string>,
) => Promise<void>;

function run(
  cmd: string,
  args: string[],
  log: LogLine,
  track: Track,
  env?: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const kill = spawnStreaming(
      cmd,
      args,
      log,
      (err) => (err ? reject(err) : resolve()),
      env ? { env } : {},
    );
    track(kill);
  });
}

/**
 * Locate the Railpack binary: `RAILPACK_BIN` when set, otherwise
 * `~/.local/bin/railpack` (where `sandbox/install-builder.sh` places it, even
 * when systemd runs without `~/.local/bin` on `PATH`), falling back to `PATH`.
 */
export function resolveRailpackBin(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  exists: (p: string) => boolean = fs.existsSync,
): string {
  const explicit = env["RAILPACK_BIN"]?.trim();
  if (explicit) return explicit;
  const localBin = path.join(home, ".local", "bin", "railpack");
  if (exists(localBin)) return localBin;
  return "railpack";
}

export function railpackPrepareArgs(opts: BuildOptions, planPath: string): string[] {
  const args = ["prepare", opts.contextDir, "--plan-out", planPath, "--error-missing-start"];
  if (opts.buildCommand) args.push("--build-cmd", opts.buildCommand);
  if (opts.startCommand) args.push("--start-cmd", opts.startCommand);
  return args;
}

export function railpackDockerBuildArgs(opts: BuildOptions, planPath: string): string[] {
  return [
    "build",
    "--build-arg",
    `BUILDKIT_SYNTAX=${RAILPACK_FRONTEND}`,
    "-f",
    planPath,
    "-t",
    opts.tag,
    opts.contextDir,
  ];
}

export async function cloneRepo(
  source: GitSource,
  dir: string,
  allowLocal: boolean,
  log: LogLine,
  track: Track,
): Promise<void> {
  const url = resolveRepoUrl(source.repo, allowLocal);
  const credentials = gitCredentialEnv(source.token);
  try {
    // `--` ends option parsing, so a repository URL can never be read as a flag.
    await run(
      "git",
      ["clone", "--depth", "1", "--branch", source.branch, "--", url, dir],
      log,
      track,
      credentials.env,
    );
  } finally {
    credentials.cleanup();
  }
}

export async function buildImageWithRunner(
  opts: BuildOptions,
  log: LogLine,
  track: Track,
  runner: StepRunner = run,
  railpackBin: string = resolveRailpackBin(),
): Promise<void> {
  if (opts.dockerfile) {
    await runner(
      "docker",
      ["build", "-t", opts.tag, "-f", opts.dockerfile, opts.contextDir],
      log,
      track,
    );
    return;
  }
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-railpack-"));
  const planPath = path.join(planDir, "railpack-plan.json");
  try {
    await runner(railpackBin, railpackPrepareArgs(opts, planPath), log, track);
    await runner("docker", railpackDockerBuildArgs(opts, planPath), log, track);
  } finally {
    fs.rmSync(planDir, { recursive: true, force: true });
  }
}

export function buildImage(opts: BuildOptions, log: LogLine, track: Track): Promise<void> {
  return buildImageWithRunner(opts, log, track);
}

export function pullImage(image: string, log: LogLine, timeoutMs: number): Promise<string> {
  return dockerPull(image, log, timeoutMs);
}
