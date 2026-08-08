import type { Request, Response, NextFunction } from "express";
import { config } from "../lib/config.js";

export type NexusIdentity = {
  id: string;
  username?: string;
  email?: string;
  roles?: string[];
  [key: string]: unknown;
};

export type AuthedRequest = Request & { userId?: string; user?: NexusIdentity };

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
 * Nexus-Auth already existed and exposed exactly the endpoint needed
 * (GET /api/v1/auth/check → 401, or 200 with { userId, user }), but nothing
 * called it: Cloud, Deploy and Vault had each grown a separate login. The
 * visible symptom was a user creating an account in Cloud and then being asked
 * to sign up again here, which is not what "one ecosystem" means.
 *
 * A session token is opaque, not a JWT, so it cannot be verified locally — this
 * asks the issuer. That is one request per authenticated call; if it becomes
 * hot, the answer is a short-lived cache keyed on the token, not going back to
 * a private user table.
 *
 * Credentials are accepted in the same three forms as before, plus the shared
 * cookie:
 *   1. Authorization: Bearer <token>   (API clients)
 *   2. nexus_session cookie            (browsers, set at the apex domain)
 *   3. ?token=<token>                  (SSE / WebSocket, which cannot set headers)
 */
/**
 * Verify a raw credential against Nexus-Auth, returning the identity or null.
 *
 * Exported for the WebSocket upgrade paths, which never pass through Express
 * middleware. They previously verified a locally-issued JWT, so leaving them
 * alone would have kept a second, private authentication path alive behind the
 * front door — the exact thing this change exists to remove.
 */
export async function verifyWithNexusAuth(token: string): Promise<NexusIdentity | null> {
  const url = `${config.nexusAuthUrl.replace(/\/+$/, "")}/api/v1/auth/check`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(config.nexusAuthTimeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as
      | { authorized?: boolean; userId?: string; user?: NexusIdentity }
      | null;
    if (!body?.authorized || !body.userId) return null;
    return body.user ?? { id: body.userId };
  } catch {
    return null;
  }
}

export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const raw = bearer ?? readSessionCookie(req) ?? (req.query.token as string | undefined);

  if (!raw) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const url = `${config.nexusAuthUrl.replace(/\/+$/, "")}/api/v1/auth/check`;

  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${raw}`, Accept: "application/json" },
      signal: AbortSignal.timeout(config.nexusAuthTimeoutMs),
    });
  } catch {
    // Identity provider unreachable. Fail closed with a distinct status: a 401
    // would tell the user their credentials are wrong, which is a lie that
    // sends them to re-authenticate against a service that is simply down.
    res.status(503).json({
      error: "Identity service unavailable",
      hint: `Could not reach Nexus-Auth at ${config.nexusAuthUrl}`,
    });
    return;
  }

  if (!response.ok) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const body = (await response.json().catch(() => null)) as
    | { authorized?: boolean; userId?: string; user?: NexusIdentity }
    | null;

  if (!body?.authorized || !body.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  req.userId = body.userId;
  // Carry the identity through so handlers can answer "who am I" without a
  // local user table to look it up in.
  req.user = body.user ?? { id: body.userId };
  next();
}
