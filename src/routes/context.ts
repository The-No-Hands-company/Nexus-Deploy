import type { NextFunction, Request, RequestHandler, Response } from "express";
import { type AuditAction, recordAudit } from "../lib/audit.js";
import { adoptOrphanProjects, bootstrapOwner, canAccessProject, type GrantedAccess, resolveAccess } from "../lib/members.js";
import { loadDb, writeDb } from "../lib/store.js";
import { type AuthedRequest, makeRequireAuth } from "../middleware/auth.js";
import type { Project } from "../types.js";
import type { AppDeps, RouteContext } from "./types.js";

export const paramOf = (req: Request, name: string): string => String(req.params[name] ?? "");

/** The access a member route can rely on: the member middleware always sets it first. */
export function accessOf(req: Request): GrantedAccess {
  const access = (req as AuthedRequest).access;
  if (!access) throw new Error("accessOf used on a route without the member middleware");
  return access;
}

/**
 * The project, if it exists and the caller may touch it. A project that exists
 * but belongs to someone else answers exactly like one that does not exist, so
 * names and ids cannot be probed.
 */
export function ownedProject(req: Request, res: Response, id: string): Project | null {
  const project = loadDb().projects.find((p) => p.id === id);
  if (!project || !canAccessProject(project, accessOf(req))) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return project;
}

export function makeContext(deps: AppDeps): RouteContext {
  const auth = makeRequireAuth(deps.authenticate) as unknown as RequestHandler;

  const memberCheck: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
    const authed = req as AuthedRequest;
    const identity = authed.user;
    if (!identity) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    // A fresh node has no members. The first founder to arrive becomes the owner
    // and takes over any projects from before ownership existed.
    if (loadDb().members.length === 0 && identity.role === "founder") {
      await writeDb((db) => {
        const owner = bootstrapOwner(db.members, identity, deps.now());
        if (owner) {
          adoptOrphanProjects(db.projects, owner.authUserId);
          recordAudit(db.audit, { actor: owner.authUserId, action: "member.grant", subject: owner.authUserId }, deps.now());
        }
      });
    }
    const access = resolveAccess(loadDb().members, identity);
    if (!access.ok) {
      res.status(403).json({
        error: access.reason,
        hint:
          access.reason === "suspended"
            ? "Your access to Deploy on this node has been suspended."
            : "Ask an operator of this node to give your account access to Deploy.",
      });
      return;
    }
    authed.access = access;
    next();
  };

  const operatorOnly: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    if (!accessOf(req).operator) {
      res.status(403).json({ error: "operators_only" });
      return;
    }
    next();
  };

  return { deps, auth, member: [auth, memberCheck], operator: [auth, memberCheck, operatorOnly] };
}

/** Record who did what. Never records where they were. */
export async function audit(
  deps: AppDeps,
  req: Request,
  action: AuditAction,
  subject?: string,
): Promise<void> {
  const actor = (req as AuthedRequest).userId ?? "unknown";
  await writeDb((db) => {
    recordAudit(db.audit, { actor, action, ...(subject !== undefined ? { subject } : {}) }, deps.now());
  });
}
