/**
 * The three things a deployment actually does to the outside world: clone a
 * repository, build an image, pull an image. They are separate from the
 * pipeline in build.ts so the pipeline can be tested with fakes, and because
 * each is only a thin, easily-read wrapper around one command.
 *
 * Each step settles when its process ends. Cancelling kills the process, which
 * makes the step reject; build.ts then reads its own flags to say *why*.
 */
import { dockerPull, spawnStreaming, type LogLine } from "./docker.js";
import { resolveRepoUrl } from "./repo.js";
import { gitCredentialEnv } from "./source.js";
import type { GitSource } from "../types.js";

/** Registers a way to stop the running step. */
export type Track = (kill: () => void) => void;

export type BuildOptions = {
  contextDir: string;
  /** Resolved Dockerfile path, or null to let Nixpacks work out the stack. */
  dockerfile: string | null;
  tag: string;
};

function run(cmd: string, args: string[], log: LogLine, track: Track, env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const kill = spawnStreaming(cmd, args, log, (err) => (err ? reject(err) : resolve()), env ? { env } : {});
    track(kill);
  });
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
    await run("git", ["clone", "--depth", "1", "--branch", source.branch, "--", url, dir], log, track, credentials.env);
  } finally {
    credentials.cleanup();
  }
}

export function buildImage(opts: BuildOptions, log: LogLine, track: Track): Promise<void> {
  return opts.dockerfile
    ? run("docker", ["build", "-t", opts.tag, "-f", opts.dockerfile, opts.contextDir], log, track)
    : run("nixpacks", ["build", opts.contextDir, "--name", opts.tag], log, track);
}

export function pullImage(image: string, log: LogLine, timeoutMs: number): Promise<string> {
  return dockerPull(image, log, timeoutMs);
}
