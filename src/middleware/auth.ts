import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/auth.js";
import { loadDb } from "../lib/store.js";

export type AuthedRequest = Request & { userId?: string };

/**
 * Auth middleware — accepts token from:
 *   1. Authorization: Bearer <token>  (API calls)
 *   2. ?token=<token>                 (SSE / WebSocket where headers can't be set)
 */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;
  const raw = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;

  if (!raw) return res.status(401).json({ error: "Unauthorized" });

  try {
    const decoded = verifyToken(raw);
    const user = loadDb().users.find(u => u.id === decoded.sub);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    req.userId = user.id;
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}
