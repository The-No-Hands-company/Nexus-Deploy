import { fileURLToPath } from "node:url";

/**
 * Turn a project's `repo` into the URL handed to `git clone`.
 *
 * Accepted: an http(s) URL, or `owner/repo` shorthand for GitHub. A `file:` URL
 * clones straight off this machine's disk, so it is refused unless the operator
 * opts in (DEPLOY_ALLOW_LOCAL_REPOS=true). Without that gate any signed-in user
 * could build an image out of any git repository on the host, and read it back
 * through the container. The lifecycle test is the one intended user.
 * Anything else (bare paths, ext::, ssh) is refused rather than guessed at.
 */
export function resolveRepoUrl(repo: string, allowLocal: boolean): string {
  if (/^file:/i.test(repo)) {
    if (!allowLocal) throw new Error("Local file: repositories are not allowed on this server");
    const url = new URL(repo);
    if (url.hostname && url.hostname !== "localhost") throw new Error("Local repository URL must use a local host");
    fileURLToPath(url); // Reject invalid file URLs before passing them to Git.
    return url.href;
  }
  if (/^https?:\/\//i.test(repo)) return repo;
  if (/^[A-Za-z0-9_-][\w.-]*\/[A-Za-z0-9_-][\w.-]*$/.test(repo)) return `https://github.com/${repo}`;
  throw new Error("Repository must be an http(s) URL or owner/repo");
}
