import type { Project, Source } from "../types.js";
/**
 * Turning a request body into something safe to store.
 *
 * Every field a member can set is validated here, at the boundary, before it is
 * persisted: a project that could never build, or that would clone off this
 * machine's disk, or smuggle an option into a command, is refused at the door.
 * Errors are plain messages that the route returns as a 400.
 */
import { validateBuildContext, validateDockerfile } from "./build-context.js";
import { resolveRepoUrl } from "./repo.js";
import { validateVolumePath } from "./run-args.js";
import { parseMemoryMb } from "./safeguards.js";
import { sourceOf, validateBranch, validateImageRef, validateToken } from "./source.js";
import { validateNotifyUrl } from "./urls.js";

type Body = Record<string, unknown>;

function asBody(value: unknown, what = "request body"): Body {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be a JSON object`);
  }
  return value as Body;
}

const present = (v: unknown) => v !== undefined && v !== null && v !== "";

function gitSource(body: Body, allowLocalRepos: boolean, fallbackBranch = "main"): Source {
  const repo = typeof body["repo"] === "string" ? body["repo"] : "";
  if (!repo) throw new Error("Missing repo");
  resolveRepoUrl(repo, allowLocalRepos);
  return {
    type: "git",
    repo,
    branch: body["branch"] === undefined ? fallbackBranch : validateBranch(body["branch"]),
    ...(present(body["token"]) ? { token: validateToken(body["token"]) } : {}),
  };
}

/** `{ source: { type, … } }`, or the older flat `{ repo, branch }`. */
export function parseSource(body: Body, allowLocalRepos: boolean): Source {
  if (body["source"] !== undefined) {
    const source = asBody(body["source"], "source");
    if (source["type"] === "image")
      return { type: "image", image: validateImageRef(source["image"]) };
    if (source["type"] === "git") return gitSource(source, allowLocalRepos);
    throw new Error('source.type must be "git" or "image"');
  }
  if (body["repo"] === undefined) throw new Error("Missing source (or repo)");
  return gitSource(body, allowLocalRepos);
}

export function validatePort(value: unknown): number {
  const port = typeof value === "string" ? Number(value) : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be a whole number between 1 and 65535");
  }
  return port;
}

export function validateHealthPath(value: unknown): string {
  if (typeof value !== "string" || !/^\/[\x21-\x7e]{0,255}$/.test(value)) {
    throw new Error("healthPath must be an absolute path such as /health");
  }
  return value;
}

function validateCommand(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 500 || /[\n\r\0]/.test(value)) {
    throw new Error(`${field} must be a single line of at most 500 characters`);
  }
  return value;
}

function validateMemory(value: unknown): string {
  if (
    typeof value !== "string" ||
    parseMemoryMb(value) === null ||
    (parseMemoryMb(value) ?? 0) <= 0
  ) {
    throw new Error("memoryLimit must look like 256m or 1g");
  }
  return value;
}

function validateCpus(value: unknown): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 64)
    throw new Error("cpus must be a positive number");
  return String(n);
}

function validateVolume(value: unknown): string {
  return value === "/workspace" ? "/workspace" : validateVolumePath(value);
}

export type NewProject = {
  name: string;
  source: Source;
  buildContext: string;
  dockerfile?: string;
  healthPath?: string;
  buildCommand: string;
  startCommand: string;
  volumePath: string;
  port: number;
};

export function parseNewProject(raw: unknown, allowLocalRepos: boolean): NewProject {
  const body = asBody(raw);
  if (typeof body["name"] !== "string" || !body["name"].trim()) throw new Error("Missing name");
  const source = parseSource(body, allowLocalRepos);
  return {
    name: body["name"],
    source,
    // Only a missing value defaults; an explicit null or empty one is a mistake to refuse.
    buildContext:
      source.type === "git" && body["buildContext"] !== undefined
        ? validateBuildContext(body["buildContext"])
        : ".",
    ...(source.type === "git" && present(body["dockerfile"])
      ? { dockerfile: validateDockerfile(body["dockerfile"], ".") }
      : {}),
    ...(present(body["healthPath"]) ? { healthPath: validateHealthPath(body["healthPath"]) } : {}),
    buildCommand:
      body["buildCommand"] === undefined
        ? "npm run build"
        : validateCommand(body["buildCommand"], "buildCommand"),
    startCommand:
      body["startCommand"] === undefined
        ? "npm start"
        : validateCommand(body["startCommand"], "startCommand"),
    volumePath:
      body["volumePath"] === undefined ? "/workspace" : validateVolume(body["volumePath"]),
    port: body["port"] === undefined ? 3000 : validatePort(body["port"]),
  };
}

export type ProjectPatch = {
  source?: Source;
  buildContext?: string;
  dockerfile?: string | null;
  healthPath?: string | null;
  buildCommand?: string;
  startCommand?: string;
  volumePath?: string;
  port?: number;
  memoryLimit?: string | null;
  cpus?: string | null;
  notifyUrl?: string | null;
  autoDeployEnabled?: boolean;
};

const cleared = (v: unknown) => v === null || v === "";

/**
 * Only the fields present in the body are changed. `null` or "" clears an
 * optional field. A token is replaced when one is sent and removed with
 * `token: null`; otherwise the stored one is kept.
 */
export function parsePatch(
  raw: unknown,
  current: Pick<Project, "repo" | "branch" | "source">,
  allowLocalRepos: boolean,
): ProjectPatch {
  const body = asBody(raw);
  const patch: ProjectPatch = {};
  const existing = sourceOf(current);

  if (body["source"] !== undefined) {
    patch.source = parseSource(body, allowLocalRepos);
  } else if (
    existing.type === "git" &&
    ["repo", "branch", "token"].some((k) => body[k] !== undefined)
  ) {
    const next = gitSource(
      { repo: body["repo"] ?? existing.repo, branch: body["branch"] ?? existing.branch },
      allowLocalRepos,
    ) as Extract<Source, { type: "git" }>;
    if (body["token"] === undefined) {
      if (existing.token) next.token = existing.token;
    } else if (!cleared(body["token"])) {
      next.token = validateToken(body["token"]);
    }
    patch.source = next;
  } else if (existing.type === "image" && body["image"] !== undefined) {
    patch.source = { type: "image", image: validateImageRef(body["image"]) };
  }

  if (body["buildContext"] !== undefined)
    patch.buildContext = validateBuildContext(body["buildContext"]);
  if (body["dockerfile"] !== undefined) {
    patch.dockerfile = cleared(body["dockerfile"])
      ? null
      : validateDockerfile(body["dockerfile"], ".");
  }
  if (body["healthPath"] !== undefined) {
    patch.healthPath = cleared(body["healthPath"]) ? null : validateHealthPath(body["healthPath"]);
  }
  if (body["buildCommand"] !== undefined)
    patch.buildCommand = validateCommand(body["buildCommand"], "buildCommand");
  if (body["startCommand"] !== undefined)
    patch.startCommand = validateCommand(body["startCommand"], "startCommand");
  if (body["volumePath"] !== undefined) patch.volumePath = validateVolume(body["volumePath"]);
  if (body["port"] !== undefined) patch.port = validatePort(body["port"]);
  if (body["memoryLimit"] !== undefined) {
    patch.memoryLimit = cleared(body["memoryLimit"]) ? null : validateMemory(body["memoryLimit"]);
  }
  if (body["cpus"] !== undefined)
    patch.cpus = cleared(body["cpus"]) ? null : validateCpus(body["cpus"]);
  if (body["notifyUrl"] !== undefined) {
    patch.notifyUrl = cleared(body["notifyUrl"]) ? null : validateNotifyUrl(body["notifyUrl"]);
  }
  if (body["autoDeployEnabled"] !== undefined)
    patch.autoDeployEnabled = Boolean(body["autoDeployEnabled"]);
  return patch;
}

type ClearableField = "dockerfile" | "healthPath" | "memoryLimit" | "cpus" | "notifyUrl";

function unset(project: Project, field: ClearableField): void {
  // An absent field is what "cleared" means. Assigning undefined would leave an
  // own key behind, which later code (and the tests) would read as "present".
  delete project[field];
}

/** Apply a validated patch to a stored project, keeping the display copy of the source in step. */
export function applyPatch(project: Project, patch: ProjectPatch, now: number): void {
  if (patch.source) {
    project.source = patch.source;
    project.repo = patch.source.type === "git" ? patch.source.repo : patch.source.image;
    project.branch = patch.source.type === "git" ? patch.source.branch : "";
  }
  if (patch.buildContext !== undefined) project.buildContext = patch.buildContext;
  if (patch.dockerfile === null) unset(project, "dockerfile");
  else if (patch.dockerfile !== undefined) project.dockerfile = patch.dockerfile;
  if (patch.healthPath === null) unset(project, "healthPath");
  else if (patch.healthPath !== undefined) project.healthPath = patch.healthPath;
  if (patch.buildCommand !== undefined) project.buildCommand = patch.buildCommand;
  if (patch.startCommand !== undefined) project.startCommand = patch.startCommand;
  if (patch.volumePath !== undefined) project.volumePath = patch.volumePath;
  if (patch.port !== undefined) project.port = patch.port;
  if (patch.memoryLimit === null) unset(project, "memoryLimit");
  else if (patch.memoryLimit !== undefined) project.memoryLimit = patch.memoryLimit;
  if (patch.cpus === null) unset(project, "cpus");
  else if (patch.cpus !== undefined) project.cpus = patch.cpus;
  if (patch.notifyUrl === null) unset(project, "notifyUrl");
  else if (patch.notifyUrl !== undefined) project.notifyUrl = patch.notifyUrl;
  if (patch.autoDeployEnabled !== undefined) project.autoDeployEnabled = patch.autoDeployEnabled;
  project.updatedAt = now;
}
