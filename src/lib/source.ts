/**
 * Where a project's code comes from, and the care that takes.
 *
 * Two sources: a Git repository (cloned and built) and a container image
 * (pulled). Both are input from a member, so both are validated before they are
 * stored, and neither is ever passed to a shell. A private-repository token is
 * handled so that it appears in no URL, no command line, no log and no API
 * response.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitSource, ImageSource, Project, Source } from "../types.js";

/** The authoritative source, falling back to the repo/branch of an older project. */
export function sourceOf(project: Pick<Project, "repo" | "branch" | "source">): Source {
  return project.source ?? { type: "git", repo: project.repo, branch: project.branch };
}

// ── Image references ───────────────────────────────────────────────────────
const COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const LABEL = "(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])";
const DOMAIN = `${LABEL}(?:\\.${LABEL})*(?::[0-9]+)?`;
const IMAGE_RE = new RegExp(
  `^(?:${DOMAIN}/)?${COMPONENT}(?:/${COMPONENT})*` +
    "(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$",
);

/**
 * `[registry[:port]/]repository[:tag][@sha256:digest]`, nothing else. The first
 * character must be a letter or digit, so a reference can never be read as a
 * command-line option, and no character that a shell treats specially is allowed.
 */
export function validateImageRef(ref: unknown): string {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 255 || !IMAGE_RE.test(ref)) {
    throw new Error("image must look like [registry/]name[:tag] or name@sha256:<digest>");
  }
  return ref;
}

/** `nginx:1.27` + a digest → `nginx@sha256:…`: the exact bytes, whatever the tag does later. */
export function pinnedImageRef(ref: string, digest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("not a sha256 digest");
  const name = ref.split("@")[0] ?? ref;
  const colon = name.indexOf(":", name.lastIndexOf("/") + 1);
  return `${colon === -1 ? name : name.slice(0, colon)}@${digest}`;
}

// ── Git sources ────────────────────────────────────────────────────────────
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export function validateBranch(branch: unknown): string {
  if (typeof branch !== "string" || !BRANCH_RE.test(branch) || branch.includes("..")) {
    throw new Error("branch must be a plain branch name such as main or release/1.2");
  }
  return branch;
}

export function validateToken(token: unknown): string {
  if (typeof token !== "string" || token.length < 4 || token.length > 512 || /\s/.test(token)) {
    throw new Error("token must be 4–512 characters with no whitespace");
  }
  return token;
}

/**
 * Environment for a `git` child process that needs to authenticate. The
 * credential travels in the child's environment and is handed to git by a small
 * helper script that holds no secret itself, so it is on no command line and in
 * no URL. "user:token" supplies a username; a bare token uses `x-access-token`,
 * which GitHub accepts for personal access tokens.
 */
export function gitCredentialEnv(
  token: string | undefined,
  workDir: string = os.tmpdir(),
): { env: Record<string, string>; cleanup: () => void } {
  const base: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (!token) return { env: base, cleanup: () => {} };

  const colon = token.indexOf(":");
  const user = colon > 0 ? token.slice(0, colon) : "x-access-token";
  const secret = colon > 0 ? token.slice(colon + 1) : token;

  const dir = fs.mkdtempSync(path.join(workDir, "nexus-askpass-"));
  const script = path.join(dir, "askpass.sh");
  fs.writeFileSync(
    script,
    '#!/bin/sh\ncase "$1" in\n  [Uu]sername*) printf "%s" "$NEXUS_GIT_USER" ;;\n  *) printf "%s" "$NEXUS_GIT_SECRET" ;;\nesac\n',
    { mode: 0o700 },
  );
  return {
    env: { ...base, GIT_ASKPASS: script, NEXUS_GIT_USER: user, NEXUS_GIT_SECRET: secret },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Replace every secret with `***` before a line is stored or streamed. */
export function redact(line: string, secrets: readonly (string | undefined)[]): string {
  let out = line;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  return out;
}

// ── What the API may show ──────────────────────────────────────────────────
export type PublicSource =
  | { type: "git"; repo: string; branch: string; hasToken: boolean }
  | ImageSource;

export type PublicProject = Omit<Project, "source"> & { source: PublicSource };

/** A project as returned to its owner: the token is reported, never repeated. */
export function publicProject(project: Project): PublicProject {
  const source = sourceOf(project);
  const shown: PublicSource =
    source.type === "git"
      ? { type: "git", repo: source.repo, branch: source.branch, hasToken: Boolean((source as GitSource).token) }
      : source;
  return { ...project, source: shown };
}
