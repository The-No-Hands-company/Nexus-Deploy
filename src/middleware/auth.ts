import type { NextFunction, Request, Response } from "express";
import { config } from "../lib/config.js";
import type { GrantedAccess } from "../lib/members.js";

export type NexusIdentity = {
  id: string;
  username?: string;
  email?: string;
  /** "founder" | "admin" | "user" … as Nexus-Auth reports it. */
  role?: string;
  [key: string]: unknown;
};

export type AuthedRequest = Request & { userId?: string; user?: NexusIdentity; access?: GrantedAccess };

/** What asking the identity service about a credential can come to. */
export type AuthResult =
  | { kind: "ok"; identity: NexusIdentity }
  | { kind: "denied" }
  | { kind: "unavailable" };

/** A function from a raw credential to who it belongs to. Injected so tests need no Nexus-Auth. */
export type Authenticator = (token: string) => Promise<AuthResult>;

const SESSION_COOKIE = "nexus_session";

/**
 * Read the session cookie without pulling in a cookie-parser dependency.
 * Browsers cannot set an Authorization header on a plain navigation, so this is
 * the credential that actually arrives when a user clicks through from another
 * app in the ecosystem.
 */
function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * Authenticate against Nexus-Auth — the ecosystem's identity service — rather
 * than against a user table owned by this app.
 *
 * Nexus-Auth exposes GET /api/v1/auth/check → 401, or 200 with { userId, user }.
 * A session token is opaque, not a JWT, so it cannot be verified locally; this
 * asks the issuer, once per authenticated call.
 */
export const authenticateWithNexusAuth: Authenticator = async (token) => {
  const url = `${config.nexusAuthUrl.replace(/\/+$/, "")}/api/v1/auth/check`;
  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(config.nexusAuthTimeoutMs),
    });
  } catch {
    // Unreachable is not "wrong credentials": telling a signed-in person to sign
    // in again because the identity service is down would be a lie.
    return { kind: "unavailable" };
  }
  if (response.status >= 500) return { kind: "unavailable" };
  if (!response.ok) return { kind: "denied" };
  const body = (await response.json().catch(() => null)) as
    | { authorized?: boolean; userId?: string; user?: NexusIdentity }
    | null;
  if (!body?.authorized || !body.userId) return { kind: "denied" };
  return { kind: "ok", identity: { ...(body.user ?? {}), id: body.userId } };
};

/** Identity for the WebSocket upgrade paths, which never pass through Express middleware. */
export async function verifyWithNexusAuth(
  token: string,
  authenticate: Authenticator = authenticateWithNexusAuth,
): Promise<NexusIdentity | null> {
  const result = await authenticate(token);
  return result.kind === "ok" ? result.identity : null;
}

/**
 * Send a browser to the ecosystem sign-in page instead of answering 401.
 * API clients still get the 401 they can act on; the two are told apart by
 * whether the request looks like a navigation (a GET accepting text/html).
 * Nexus-Auth refuses any redirect target outside the parent domain, so this
 * cannot become an open redirect.
 */
function wantsHtml(req: Request): boolean {
  return req.method === "GET" && (req.headers.accept ?? "").includes("text/html");
}

function loginUrlFor(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.get("host") ?? "";
  const here = `${proto}://${host}${req.originalUrl}`;
  const base = config.nexusAuthPublicUrl.replace(/\/+$/, "");
  return `${base}/login?redirect=${encodeURIComponent(here)}`;
}

function denyUnauthenticated(req: Request, res: Response): void {
  if (wantsHtml(req)) {
    res.redirect(302, loginUrlFor(req));
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}

/**
 * Credentials are accepted as `Authorization: Bearer`, the shared session
 * cookie, or `?token=` (for SSE, which cannot set headers).
 */
export function makeRequireAuth(authenticate: Authenticator) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const raw = bearer ?? readSessionCookie(req) ?? (req.query["token"] as string | undefined);
    if (!raw) {
      denyUnauthenticated(req, res);
      return;
    }
    const result = await authenticate(raw);
    if (result.kind === "unavailable") {
      res.status(503).json({
        error: "Identity service unavailable",
        hint: "Nexus-Auth could not be reached. Try again shortly.",
      });
      return;
    }
    if (result.kind === "denied") {
      denyUnauthenticated(req, res);
      return;
    }
    req.userId = result.identity.id;
    req.user = result.identity;
    next();
  };
}
