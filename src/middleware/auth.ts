import crypto from "node:crypto";
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

export type AuthedRequest = Request & {
  userId?: string;
  user?: NexusIdentity;
  access?: GrantedAccess;
};

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
export function readSessionCookie(req: { headers: { cookie?: string } }): string | undefined {
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

const STREAM_TICKET_PREFIX = "wst1.";
const STREAM_TICKET_TTL_MS = 60 * 60 * 1000;

/**
 * Short-lived HMAC ticket for WebSocket log streams.
 *
 * The ecosystem session cookie is HttpOnly (so browser JS cannot read it) and
 * the edge proxy strips Cookie headers on WebSocket upgrades to non-terminal
 * hosts. Issuing a Deploy-scoped ticket from GET /api/me lets the browser open
 * /api/log-stream and /api/container-stream without ever exposing the session
 * cookie to JavaScript.
 */
export function issueStreamTicket(identity: NexusIdentity, nowMs = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({
      id: identity.id,
      ...(typeof identity.username === "string" ? { username: identity.username } : {}),
      ...(typeof identity.email === "string" ? { email: identity.email } : {}),
      ...(typeof identity.role === "string" ? { role: identity.role } : {}),
      exp: nowMs + STREAM_TICKET_TTL_MS,
    }),
    "utf8",
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", config.appSecret).update(payload).digest("base64url");
  return `${STREAM_TICKET_PREFIX}${payload}.${sig}`;
}

export function verifyStreamTicket(ticket: string, nowMs = Date.now()): NexusIdentity | null {
  if (!ticket.startsWith(STREAM_TICKET_PREFIX)) return null;
  const rest = ticket.slice(STREAM_TICKET_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const payload = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  const expected = crypto
    .createHmac("sha256", config.appSecret)
    .update(payload)
    .digest("base64url");
  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      id?: unknown;
      username?: unknown;
      email?: unknown;
      role?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.id !== "string" || !parsed.id) return null;
    if (typeof parsed.exp !== "number" || parsed.exp <= nowMs) return null;
    return {
      id: parsed.id,
      ...(typeof parsed.username === "string" ? { username: parsed.username } : {}),
      ...(typeof parsed.email === "string" ? { email: parsed.email } : {}),
      ...(typeof parsed.role === "string" ? { role: parsed.role } : {}),
    };
  } catch {
    return null;
  }
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
  const body = (await response.json().catch(() => null)) as {
    authorized?: boolean;
    userId?: string;
    user?: NexusIdentity;
  } | null;
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

export function loginUrlFor(req: Request, pathOverride?: string): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.get("host") ?? "";
  const safePath =
    pathOverride === undefined
      ? req.originalUrl
      : pathOverride.startsWith("/") && !pathOverride.startsWith("//")
        ? pathOverride
        : "/";
  const here = `${proto}://${host}${safePath}`;
  const base = config.nexusAuthPublicUrl.replace(/\/+$/, "");
  return `${base}/login?redirect=${encodeURIComponent(here)}`;
}

export function logoutUrlFor(): string {
  const base = config.nexusAuthPublicUrl.replace(/\/+$/, "");
  return `${base}/logout`;
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
