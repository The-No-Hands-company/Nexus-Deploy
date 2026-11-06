import crypto from "node:crypto";
import express, { type Express } from "express";
import { sourceOf } from "../lib/source.js";
import { loadDb } from "../lib/store.js";
import { cleanCommit } from "./lifecycle.js";
import type { RouteContext } from "./types.js";

/** `sha256=<hex>` of the exact bytes received, compared without leaking timing. */
export function signatureMatches(
  secret: string,
  body: Buffer,
  header: string | undefined,
): boolean {
  if (!header) return false;
  const expected = Buffer.from(
    `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`,
  );
  const given = Buffer.from(header);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * GitHub push webhook. Registered on the app itself, ahead of the JSON parser:
 * the signature is over the raw bytes, which a parsed body no longer has.
 *
 * A valid signature is required every time. (An earlier version skipped the check
 * when the header was absent, which let anyone who knew a project id start builds.)
 */
export function webhookRoutes(app: Express, ctx: RouteContext): void {
  const { deps } = ctx;

  app.post(
    "/api/webhooks/github/:projectId",
    express.raw({ type: "*/*", limit: "1mb" }),
    (req, res) => {
      const project = loadDb().projects.find((p) => p.id === req.params["projectId"]);
      if (!project) return void res.status(404).json({ error: "Project not found" });

      const secret = project.webhookSecret;
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!secret) return void res.status(403).json({ error: "Webhook not configured" });
      if (!signatureMatches(secret, body, req.get("x-hub-signature-256"))) {
        return void res.status(401).json({ error: "Invalid signature" });
      }

      const event = req.get("x-github-event");
      if (event === "ping") return void res.json({ ok: true, pong: true });
      if (event !== undefined && event !== "push")
        return void res.json({ ok: true, skipped: `event ${event}` });

      let payload: { ref?: unknown; after?: unknown };
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        return void res.status(400).json({ error: "Bad payload" });
      }

      const source = sourceOf(project);
      if (source.type !== "git") {
        return void res.status(400).json({ error: "Image projects do not use push webhooks" });
      }
      const branch =
        typeof payload.ref === "string" ? payload.ref.replace("refs/heads/", "") : undefined;
      if (branch && branch !== source.branch) {
        return void res.json({ ok: true, skipped: `branch ${branch} ≠ ${source.branch}` });
      }
      if (!project.autoDeployEnabled)
        return void res.json({ ok: true, skipped: "auto-deploy disabled" });
      if (deps.pipeline.isBuilding(project.id))
        return void res.json({ ok: true, skipped: "build in progress" });

      // A suspended member's projects stop building on push too.
      const owner = loadDb().members.find((m) => m.authUserId === project.ownerId);
      if (owner?.status === "suspended")
        return void res.json({ ok: true, skipped: "owner suspended" });

      // Pushes count against the same safeguards as a manual deploy, or a push loop would bypass them.
      const verdict = deps.pipeline.guardBuild(project);
      if (!verdict.ok) return void res.json({ ok: true, skipped: verdict.message });

      const dep = deps.pipeline.createDeployment(project, cleanCommit(payload.after), "webhook");
      deps.pipeline.runDeploy(project, dep.id).catch(() => {});
      res.json({ ok: true, deploymentId: dep.id });
    },
  );
}
