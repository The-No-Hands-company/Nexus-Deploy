import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/auth.js";
import { loadDb } from "../lib/store.js";

export type AuthedRequest = Request & { userId?: string };

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  try {
    const token = header.slice(7);
    const decoded = verifyToken(token);
    const db = loadDb();
    const user = db.users.find(u => u.id === decoded.sub);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    req.userId = user.id;
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}
