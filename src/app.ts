import path from "node:path";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import { aiRoutes } from "./routes/ai.js";
import { basicRoutes } from "./routes/basic.js";
import { makeContext } from "./routes/context.js";
import { projectRoutes } from "./routes/projects.js";
import type { AppDeps } from "./routes/types.js";

export type { AppDeps } from "./routes/types.js";

/**
 * The HTTP application, built from injected dependencies so that every route can
 * be exercised in tests without Nexus-Auth, Docker or Git. src/index.ts wires in
 * the real ones and starts listening.
 */
export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false, frameguard: false }));
  app.use(cors());

  const ctx = makeContext(deps);

  app.use(express.json({ limit: "1mb" }));

  const api = express.Router();
  basicRoutes(api, ctx);
  aiRoutes(api, ctx);
  projectRoutes(api, ctx);
  app.use(api);

  // An unknown API path is a JSON 404, never the dashboard's HTML.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  if (deps.staticDir) {
    const dir = path.resolve(deps.staticDir);
    app.use(express.static(dir));
    app.use((_req, res) => res.sendFile(path.join(dir, "index.html")));
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    // A malformed JSON body is the caller's mistake; anything else is ours and
    // must not leak a stack trace.
    if (err && typeof err === "object" && "type" in err && err.type === "entity.parse.failed") {
      res.status(400).json({ error: "Request body is not valid JSON" });
      return;
    }
    console.error("[nexus] request error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Internal error" });
  };
  app.use(onError);

  return app;
}
