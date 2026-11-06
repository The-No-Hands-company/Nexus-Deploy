import type { Router } from "express";
import { describeNexusAiIntegration, requestDeployAssistantSuggestion } from "../lib/ai.js";
import type { RouteContext } from "./types.js";

/** The optional Nexus AI deploy assistant. Unchanged in behaviour; now behind the member gate. */
export function aiRoutes(router: Router, ctx: RouteContext): void {
  router.get("/api/ai/integration", ...ctx.member, (_req, res) => {
    res.json({ integration: describeNexusAiIntegration() });
  });

  router.post("/api/ai/deploy-assist", ...ctx.member, async (req, res) => {
    const prompt = String(req.body?.prompt ?? "").trim();
    if (!prompt) return void res.status(400).json({ error: "Missing prompt" });

    try {
      const suggestion = await requestDeployAssistantSuggestion({
        prompt,
        model: typeof req.body?.model === "string" ? req.body.model : undefined,
        temperature: typeof req.body?.temperature === "number" ? req.body.temperature : undefined,
        context: {
          projectId: req.body?.projectId,
          repo: req.body?.repo,
          branch: req.body?.branch,
          buildCommand: req.body?.buildCommand,
          startCommand: req.body?.startCommand,
        },
      });
      res.json(suggestion);
    } catch (error) {
      const message = (error as Error).message;
      res.status(message.includes("not configured") ? 503 : 502).json({ error: message });
    }
  });
}
