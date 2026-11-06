import type { Request, Response, Router } from "express";
import { grantMember, resolveAccess, setMemberStatus } from "../lib/members.js";
import { loadDb, writeDb } from "../lib/store.js";
import type { AuthedRequest } from "../middleware/auth.js";
import type { MemberStatus } from "../types.js";
import { audit, paramOf } from "./context.js";
import type { RouteContext } from "./types.js";

const ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;

export function basicRoutes(router: Router, ctx: RouteContext): void {
  const { deps } = ctx;

  router.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      name: "nexus-deploy",
      version: deps.version,
      time: new Date(deps.now()).toISOString(),
    });
  });

  // Who am I, and am I let in? Answered even for an account that is not a member,
  // so the dashboard can show "ask an operator" instead of a bare error.
  router.get("/api/me", ctx.auth, (req: Request, res: Response) => {
    const identity = (req as AuthedRequest).user;
    if (!identity) return void res.status(401).json({ error: "Unauthorized" });
    const access = resolveAccess(loadDb().members, identity);
    res.json({
      user: identity,
      access: access.ok
        ? { member: true, operator: access.operator }
        : { member: false, reason: access.reason },
    });
  });

  // What this node's safeguards are, shown so nobody is surprised by them.
  router.get("/api/limits", ...ctx.member, (_req, res) => {
    res.json({
      limits: deps.limits,
      baseDomain: deps.node.baseDomain,
      controlHost: deps.node.controlHost,
      appHostPattern: deps.node.hostPattern,
      availability: "best-effort",
    });
  });

  // ── Members (operators only) ─────────────────────────────────────────────
  router.get("/api/admin/members", ...ctx.operator, (_req, res) => {
    res.json({ members: loadDb().members });
  });

  router.post("/api/admin/members", ...ctx.operator, async (req, res) => {
    const body = req.body as { authUserId?: unknown; label?: unknown } | null;
    if (typeof body?.authUserId !== "string" || !ID_RE.test(body.authUserId)) {
      return void res.status(400).json({ error: "authUserId must be the account's Nexus-Auth id" });
    }
    if (body.label !== undefined && (typeof body.label !== "string" || body.label.length > 80)) {
      return void res.status(400).json({ error: "label must be text of at most 80 characters" });
    }
    const actor = (req as AuthedRequest).user;
    if (!actor) return void res.status(401).json({ error: "Unauthorized" });
    let granted = null as ReturnType<typeof grantMember> | null;
    const target: { authUserId: string; label?: string } = { authUserId: body.authUserId };
    if (typeof body.label === "string") target.label = body.label;
    await writeDb((db) => {
      granted = grantMember(db.members, actor, target, deps.now());
    });
    await audit(deps, req, "member.grant", body.authUserId);
    res.status(201).json({ member: granted });
  });

  router.patch("/api/admin/members/:authUserId", ...ctx.operator, async (req, res) => {
    const status = (req.body as { status?: unknown } | null)?.status;
    if (status !== "active" && status !== "suspended") {
      return void res.status(400).json({ error: 'status must be "active" or "suspended"' });
    }
    const authUserId = paramOf(req, "authUserId");
    let result: ReturnType<typeof setMemberStatus> = "not_found";
    await writeDb((db) => {
      result = setMemberStatus(db.members, authUserId, status as MemberStatus);
    });
    if (result === "not_found") return void res.status(404).json({ error: "Not found" });
    if (result === "is_owner")
      return void res.status(409).json({ error: "An owner cannot be suspended" });
    await audit(
      deps,
      req,
      status === "suspended" ? "member.suspend" : "member.reactivate",
      authUserId,
    );
    res.json({ ok: true });
  });

  router.get("/api/admin/audit", ...ctx.operator, (_req, res) => {
    res.json({ audit: loadDb().audit.slice(0, 200) });
  });
}
