import crypto from "node:crypto";
import type { Router } from "express";
import { newId } from "../lib/auth.js";
import { validateEnv } from "../lib/env.js";
import { canAccessProject } from "../lib/members.js";
import { checkSlug, slugify } from "../lib/names.js";
import { applyPatch, parseNewProject, parsePatch } from "../lib/project-input.js";
import { recordAudit } from "../lib/audit.js";
import { checkProjectQuota } from "../lib/safeguards.js";
import { publicProject } from "../lib/source.js";
import { loadDb, writeDb } from "../lib/store.js";
import type { Project } from "../types.js";
import { accessOf, audit, ownedProject, paramOf } from "./context.js";
import type { RouteContext } from "./types.js";

const REASON_STATUS = { invalid: 400, reserved: 400, taken: 409, unverified: 503 } as const;

export function projectRoutes(router: Router, ctx: RouteContext): void {
  const { deps } = ctx;

  router.get("/api/projects", ...ctx.member, (req, res) => {
    const access = accessOf(req);
    const db = loadDb();
    res.json({
      projects: db.projects
        .filter((p) => canAccessProject(p, access))
        .map((p) => ({
          ...publicProject(p),
          latestDeployment: db.deployments.find((d) => d.projectId === p.id) ?? null,
        })),
    });
  });

  router.post("/api/projects", ...ctx.member, async (req, res) => {
    const access = accessOf(req);
    let input: ReturnType<typeof parseNewProject>;
    try {
      input = parseNewProject(req.body, deps.allowLocalRepos);
    } catch (error) {
      return void res.status(400).json({ error: (error as Error).message });
    }

    const owned = loadDb().projects.filter((p) => p.ownerId === access.memberId).length;
    const quota = checkProjectQuota(owned, deps.limits);
    if (!quota.ok) return void res.status(403).json({ error: quota.message, code: quota.code });

    const slug = slugify(input.name);
    const name = await checkSlug(slug, {
      takenLocally: (s) => loadDb().projects.some((p) => p.name === s),
      takenElsewhere: deps.takenElsewhere,
    });
    if (!name.ok) return void res.status(REASON_STATUS[name.reason]).json({ error: name.message, code: name.reason });

    const now = deps.now();
    const project: Project = {
      id: newId("prj"),
      ownerId: access.memberId,
      name: slug,
      repo: input.source.type === "git" ? input.source.repo : input.source.image,
      branch: input.source.type === "git" ? input.source.branch : "",
      source: input.source,
      buildContext: input.buildContext,
      ...(input.dockerfile ? { dockerfile: input.dockerfile } : {}),
      ...(input.healthPath ? { healthPath: input.healthPath } : {}),
      buildCommand: input.buildCommand,
      startCommand: input.startCommand,
      volumePath: input.volumePath,
      port: input.port,
      env: {},
      status: "idle",
      webhookSecret: crypto.randomBytes(24).toString("hex"),
      autoDeployEnabled: true,
      createdAt: now,
      updatedAt: now,
    };

    // Checked again inside the write, so two simultaneous creates cannot both win the name.
    let taken = false;
    await writeDb((db) => {
      if (db.projects.some((p) => p.name === slug)) {
        taken = true;
        return;
      }
      db.projects.unshift(project);
      recordAudit(db.audit, { actor: access.memberId, action: "project.create", subject: project.id }, now);
    });
    if (taken) return void res.status(409).json({ error: `"${slug}" is already taken.`, code: "taken" });
    res.status(201).json({ project: publicProject(project) });
  });

  router.get("/api/projects/:id", ...ctx.member, (req, res) => {
    const project = ownedProject(req, res, paramOf(req, "id"));
    if (!project) return;
    res.json({
      project: publicProject(project),
      deployments: loadDb().deployments.filter((d) => d.projectId === project.id),
    });
  });

  router.put("/api/projects/:id", ...ctx.member, async (req, res) => {
    const project = ownedProject(req, res, paramOf(req, "id"));
    if (!project) return;
    let patch: ReturnType<typeof parsePatch>;
    try {
      patch = parsePatch(req.body, project, deps.allowLocalRepos);
    } catch (error) {
      return void res.status(400).json({ error: (error as Error).message });
    }
    await writeDb((db) => {
      const stored = db.projects.find((p) => p.id === project.id);
      if (stored) applyPatch(stored, patch, deps.now());
    });
    await audit(deps, req, "project.update", project.id);
    const updated = loadDb().projects.find((p) => p.id === project.id);
    if (!updated) return void res.status(404).json({ error: "Not found" });
    res.json({ project: publicProject(updated) });
  });

  router.put("/api/projects/:id/env", ...ctx.member, async (req, res) => {
    const project = ownedProject(req, res, paramOf(req, "id"));
    if (!project) return;
    let env: Record<string, string>;
    try {
      env = validateEnv((req.body as { env?: unknown } | null)?.env);
    } catch (error) {
      return void res.status(400).json({ error: (error as Error).message });
    }
    await writeDb((db) => {
      const stored = db.projects.find((p) => p.id === project.id);
      if (stored) {
        stored.env = env;
        stored.updatedAt = deps.now();
      }
    });
    await audit(deps, req, "project.update", project.id);
    res.json({ ok: true });
  });

  router.post("/api/projects/:id/regen-webhook-secret", ...ctx.member, async (req, res) => {
    const project = ownedProject(req, res, paramOf(req, "id"));
    if (!project) return;
    const secret = crypto.randomBytes(24).toString("hex");
    await writeDb((db) => {
      const stored = db.projects.find((p) => p.id === project.id);
      if (stored) {
        stored.webhookSecret = secret;
        stored.updatedAt = deps.now();
      }
    });
    res.json({ webhookSecret: secret });
  });
}
