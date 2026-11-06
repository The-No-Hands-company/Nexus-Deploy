/**
 * Who may call an app what.
 *
 * A slug becomes a hostname (`<slug>.<base domain>`) and a short link
 * (`<control host>/<slug>`), and on a shared apex it competes with ecosystem
 * hosts and with Hosting's member sites. So a slug is accepted only when it is
 * well formed, not reserved, and not already used anywhere we can ask.
 */

/** Lowercase DNS label: starts with a letter, no "--" (punycode lives there). */
export const SLUG_RE = /^(?!.*--)[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

/** Hosts the ecosystem uses, and paths the dashboard serves on the control host. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // ecosystem hosts
  "app", "auth", "api", "cloud", "chat", "mail", "email", "draw", "calendar", "project",
  "hosting", "deploy", "dashboard", "status", "storage", "www", "admin", "terminal",
  "docs", "vault", "forge", "edge", "router", "guardian", "tunnel", "tnhc", "nexus",
  "phantom", "support", "help", "blog", "community", "git",
  // control-host paths
  "assets", "health", "internal", "login", "logout", "static", "favicon", "robots",
  "index", "webhooks", "events", "projects", "deployments", "activity",
]);

/** "My App!" → "my-app". Not guaranteed valid: pass the result to checkSlug. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export type NameCheck =
  | { ok: true }
  | { ok: false; reason: "invalid" | "reserved" | "taken" | "unverified"; message: string };

export type NameDeps = {
  /** Another Deploy project already owns the slug. */
  takenLocally(slug: string): boolean;
  /** Cloud's registry or Hosting already uses it. Throwing means "could not check". */
  takenElsewhere(slug: string): Promise<boolean>;
};

export async function checkSlug(slug: string, deps: NameDeps): Promise<NameCheck> {
  if (!SLUG_RE.test(slug)) {
    return {
      ok: false,
      reason: "invalid",
      message: "Use 3–40 lowercase letters, digits and single hyphens, starting with a letter.",
    };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, reason: "reserved", message: `"${slug}" is reserved.` };
  }
  if (deps.takenLocally(slug)) {
    return { ok: false, reason: "taken", message: `"${slug}" is already taken.` };
  }
  try {
    if (await deps.takenElsewhere(slug)) {
      return { ok: false, reason: "taken", message: `"${slug}" is already taken.` };
    }
  } catch {
    // Fail closed: if we cannot tell whether a name is free, it is not given out.
    return {
      ok: false,
      reason: "unverified",
      message: "Could not check whether that name is free. Try again shortly.",
    };
  }
  return { ok: true };
}
