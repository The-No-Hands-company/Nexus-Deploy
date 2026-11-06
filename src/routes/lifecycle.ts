import type { Request, Response, Router } from "express";
import { containerNameOf } from "../lib/containers.js";
import { onStatusChange } from "../lib/events.js";
import { canAccessProject } from "../lib/members.js";
import type { Verdict } from "../lib/safeguards.js";
import { publicProject } from "../lib/source.js";
import { loadDb, writeDb } from "../lib/store.js";
import type { Deployment } from "../types.js";
import { accessOf, audit, ownedProject, paramOf } from "./context.js";
import type { RouteContext } from "./types.js";

const VERDICT_STATUS = { quota: 403, busy: 409, rate: 429, disk: 503 } as const;

/** A commit label ends up in logs and notifications, so only a plain one is kept. */
export function cleanCommit(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value) ? value : "manual";
}

export function refuse(res: Response, verdict: Extract<Verdict, { ok: false }>): void {
  res.status(VERDICT_STATUS[verdict.code]).json({ error: verdict.message, code: verdict.code });
}

/** The deployment, if it exists and belongs to a project the caller may touch. */
function ownedDeployment(req: Request, res: Response, id: string): Deployment | null {
  const dep = loadDb().deployments.find((d) => d.id === id);
  const project = dep && loadDb().projects.find((p) => p.id === dep.projectId);
  if (!dep || !project || !canAccessProject(project, accessOf(req))) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return dep;
}

export function lifecycleRoutes(router: Router, ctx: RouteContext): void {
  const { deps } = ctx;
  const { pipeline, ops } = deps;

  // ── Deploy ───────────────────────────────────────────────────────────────
  router.post("/api/projects/:id/deploy", ...ctx.member, async (req, res) => {
    const project = ownedProject(req, res, paramOf(req, "id"));
    if (!project) return;
    if (pipeline.isBuilding(project.id))
      return void res.status(409).json({ error: "Build already in progress" });
    const verdict = pipeline.guardBuild(project);
    if (!verdict.ok) return void refuse(res, verdict);

    const dep = pipeline.createDeployment(project, cleanCommit(req.body?.commitSha), "manual");
    pipeline
      .runDeploy(project, dep.id)
      .catch((err) => console.error("[nexus] deploy error:", (err as Error).message));
    await audit(deps, req, "deploy.start", project.id);
    res.json({ deployment: dep });
  });

  router.post("/api/deployments/:id/rollback", ...ctx.member, async (req, res) => {
    const source = ownedDeployment(req, res, paramOf(req, "id"));
    if (!source) return;
    if (!source.imageTag)
      return void res.status(400).json({ error: "No image — cannot roll back" });
    const project = loadDb().projects.find((p) => p.id === source.projectId);
    if (!project) return void res.status(404).json({ error: "Not found" });
    if (pipeline.isBuilding(project.id))
      return void res.status(409).json({ error: "Build in progress" });

    const dep = pipeline.createDeployment(
      project,
      `rollback:${source.commitSha.slice(0, 8)}`,
      "rollback",
    );
    await writeDb((db) => {
      const found = db.deployments.find((d) => d.id === dep.id);
      if (found) found.imageTag = source.imageTag;
    });
    pipeline.runRollback(project, dep.id, source.imageTag).catch(() => {});
    await audit(deps, req, "deploy.rollback", project.id);
    res.json({ deployment: dep });
  });

  router.post("/api/deployments/:id/cancel", ...ctx.member, async (req, res) => {
    const dep = ownedDeployment(req, res, paramOf(req, "id"));
    if (!dep) return;
    if (dep.status !== "building" && dep.status !== "queued") {
      return void res.status(400).json({ error: "Deployment is not in progress" });
    }
    const cancelled = await pipeline.cancelBuild(dep.id);
    if (!cancelled) {
      await writeDb((db) => {
        const d = db.deployments.find((x) => x.id === dep.id);
        if (d) {
          d.status = "cancelled";
          d.finishedAt = deps.now();
        }
      });
    }
    await audit(deps, req, "deploy.cancel", dep.projectId);
    res.json({ ok: true, cancelled });
  });

  // ── Build logs ───────────────────────────────────────────────────────────
  router.get("/api/deployments/:id/logs", ...ctx.member, (req, res) => {
    const dep = ownedDeployment(req, res, paramOf(req, "id"));
    if (!dep) return;
    res.json({ logs: dep.logs, status: dep.status });
  });

  // The owner can erase a build's log. Nothing else keeps it for them.
  router.delete("/api/deployments/:id/logs", ...ctx.member, async (req, res) => {
    const dep = ownedDeployment(req, res, paramOf(req, "id"));
    if (!dep) return;
    if (dep.status === "building" || dep.status === "queued") {
      return void res.status(409).json({ error: "This build is still running" });
    }
    await writeDb((db) => {
      const d = db.deployments.find((x) => x.id === dep.id);
      if (d) d.logs = ["[nexus] Log deleted by its owner"];
    });
    await audit(deps, req, "logs.delete", dep.projectId);
    res.json({ ok: true });
  });

  // ── Running container ────────────────────────────────────────────────────
  const setStatus = (id: string, status: "stopped" | "live") =>
    writeDb((db) => {
      const p = db.projects.find((x) => x.id === id);
      if (p) {
        p.status = status;
        p.updatedAt = deps.now();
      }
    });

  router.post("/api/projects/:id/stop", ...ctx.member, async (req, res) => {
    const project = ownedProject(req, res, paramOf(req, "id"));
    if (!project) return;
    await ops.stop(containerNameOf(project));
    await setStatus(project.id, "stopped");
    await audit(deps, req, "project.stop", project.id);
    res.json({ ok: true });
  });

  router.post("/api/projects/:id/start", ...ctx.member, async (req, res) => {
    const project = ownedProject(req, res, paramOf(req, "id"));
    if (!project) return;
    await ops.start(containerNameOf(project));
    await setStatus(project.id, "live");
    await audit(deps, req, "project.start", project.id);
    res.json({ ok: true });
  });

  router.post("/api/projects/:id/restart", ...ctx.member, async (req, res) => {
    const project = ownedProject(req, res, paramOf(req, "id"));
    if (!project) return;
    if (!project.containerName && !project.containerId) {
      return void res.status(400).json({ error: "No container to restart" });
    }
    await ops.restart(containerNameOf(project));
    await setStatus(project.id, "live");
    await audit(deps, req, "project.restart", project.id);
    res.json({ ok: true });
  });

  router.get("/api/projects/:id/health", ...ctx.member, async (req, res) => {
    const project = ownedProject(req, res, paramOf(req, "id"));
    if (!project) return;
    const status = await ops.status(containerNameOf(project));
    const healthy = status === "running";
    if (!healthy && project.status === "live") await setStatus(project.id, "stopped");
    res.json({ healthy, dockerStatus: status });
  });

  router.get("/api/projects/:id/stats", ...ctx.member, async (req, res) => {
    const project = ownedProject(req, res, paramOf(req, "id"));
    if (!project) return;
    if (project.status !== "live") return void res.json({ stats: null, reason: "not running" });
    res.json({ stats: await ops.stats(containerNameOf(project)) });
  });

  // ── Activity and live status ─────────────────────────────────────────────
  router.get("/api/activity", ...ctx.member, (req, res) => {
    const access = accessOf(req);
    const db = loadDb();
    const visible = new Map(
      db.projects.filter((p) => canAccessProject(p, access)).map((p) => [p.id, p.name]),
    );
    res.json({
      activity: db.deployments
        .filter((d) => visible.has(d.projectId))
        .slice(0, 25)
        .map((d) => ({
          id: d.id,
          projectId: d.projectId,
          projectName: visible.get(d.projectId) ?? "deleted",
          commitSha: d.commitSha,
          triggeredBy: d.triggeredBy,
          status: d.status,
          createdAt: d.createdAt,
          finishedAt: d.finishedAt,
        })),
    });
  });

  // Status changes for the caller's own projects only.
  router.get("/api/events", ...ctx.member, (req, res) => {
    const access = accessOf(req);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ type: "connected" });

    const unsubscribe = onStatusChange((projectId, status) => {
      const project = loadDb().projects.find((p) => p.id === projectId);
      if (project && canAccessProject(project, access)) send({ type: "status", projectId, status });
    });
    const heartbeat = setInterval(() => send({ type: "ping" }), 20_000);
    req.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  // ── Your data is yours ───────────────────────────────────────────────────
  // Everything needed to recreate the project elsewhere. The repository token
  // and webhook secret are credentials, not settings, and are left out.
  router.get("/api/projects/:id/export", ...ctx.member, (req, res) => {
    const project = ownedProject(req, res, paramOf(req, "id"));
    if (!project) return;
    const source = publicProject(project).source;
    res.json({
      exportedAt: new Date(deps.now()).toISOString(),
      format: "nexus-deploy-project/1",
      project: {
        name: project.name,
        source:
          source.type === "git"
            ? { type: "git", repo: source.repo, branch: source.branch }
            : source,
        buildContext: project.buildContext,
        dockerfile: project.dockerfile ?? null,
        healthPath: project.healthPath ?? null,
        volumePath: project.volumePath,
        port: project.port,
        env: project.env,
        memoryLimit: project.memoryLimit ?? null,
        cpus: project.cpus ?? null,
        notifyUrl: project.notifyUrl ?? null,
        autoDeployEnabled: project.autoDeployEnabled,
      },
    });
  });

  // Deleting a project removes everything it left behind: containers, the route,
  // the data volume, its images, its logs and its name.
  router.delete("/api/projects/:id", ...ctx.member, async (req, res) => {
    const project = ownedProject(req, res, paramOf(req, "id"));
    if (!project) return;
    if (pipeline.isBuilding(project.id)) {
      return void res.status(409).json({ error: "A build is running; cancel it first" });
    }
    const db = loadDb();
    const images = new Set(
      [
        project.imageTag,
        project.previousImageTag,
        ...db.deployments.filter((d) => d.projectId === project.id).map((d) => d.imageTag),
      ].filter((ref): ref is string => Boolean(ref)),
    );
    for (const name of new Set([containerNameOf(project), `nexus-app-${project.name}`])) {
      await ops.remove(name).catch(() => {});
    }
    await deps.publisher.unpublish(project.name).catch(() => {});
    await ops.removeVolume(`nexus-vol-${project.name}`).catch(() => {});
    for (const ref of images) await ops.removeImage(ref).catch(() => false);
    await writeDb((d) => {
      d.projects = d.projects.filter((p) => p.id !== project.id);
      d.deployments = d.deployments.filter((x) => x.projectId !== project.id);
    });
    await audit(deps, req, "project.delete", project.id);
    res.json({ ok: true });
  });
}
