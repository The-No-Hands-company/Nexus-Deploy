import fs from "node:fs";
import path from "node:path";

/** Validate before persistence; filesystem checks wait until after cloning. */
export function validateBuildContext(value: unknown = "."): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\\") ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.split("/").includes("..")
  ) {
    throw new Error("buildContext must be a relative directory without traversal");
  }
  return path.posix.normalize(value);
}

/** Real paths also prevent a repository symlink from escaping the clone. */
export function resolveBuildContext(cloneDir: string, value: unknown = "."): string {
  const context = validateBuildContext(value);
  const root = fs.realpathSync(cloneDir);
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(root, context));
    if (!fs.statSync(resolved).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("buildContext must identify an existing directory in the cloned repository");
  }
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("buildContext must remain inside the cloned repository");
  }
  return resolved;
}

/** The Dockerfile path, relative to the repository root. Defaults to the one in
 *  the build context; set it separately when the context must be wider than the
 *  app, e.g. a monorepo app that imports a sibling package. */
export function validateDockerfile(value: unknown, buildContext: string): string {
  if (value === undefined || value === null) return path.posix.join(buildContext, "Dockerfile");
  try { return validateBuildContext(value); }
  catch { throw new Error("dockerfile must be a relative path without traversal"); }
}

/** Resolved Dockerfile inside the clone, or null when there is none (Nixpacks). */
export function resolveDockerfile(cloneDir: string, value: string): string | null {
  const root = fs.realpathSync(cloneDir);
  const candidate = path.resolve(root, validateDockerfile(value, "."));
  if (!fs.existsSync(candidate)) return null;
  const resolved = fs.realpathSync(candidate);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("dockerfile must remain inside the cloned repository");
  }
  if (!fs.statSync(resolved).isFile()) throw new Error("dockerfile must be a file");
  return resolved;
}
