import express from "express";
import cors from "cors";
import helmet from "helmet";
import crypto from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { config, ensureDataDir } from "./lib/config.js";
import { loadDb, saveDb, writeDb } from "./lib/store.js";
import { createToken, hashPassword, newId, verifyPassword, verifyToken } from "./lib/auth.js";
import { createDeployment, runDeploy, runRollback, subscribeToDeployment, isBuilding } from "./lib/build.js";
import { dockerStop, dockerStart, dockerRemove, dockerStatus } from "./lib/docker.js";
import { startStatusSync } from "./lib/status-sync.js";
import { requireAuth, type AuthedRequest } from "./middleware/auth.js";
import type { Project, User } from "./types.js";

ensureDataDir();
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "1mb" }));

function publicUser(u: User) {
  return { id: u.id, email: u.email, role: u.role, createdAt: u.createdAt };
}

// ── Seed admin ─────────────────────────────────────────────────────────────
async function seedAdmin() {
  const db = loadDb();
  if (db.users.length) return;
  const passwordHash = await hashPassword(config.adminPassword);
  const admin: User = { id: newId("usr"), email: config.adminEmail, passwordHash, role: "owner", createdAt: Date.now() };
  db.users.push(admin);
  saveDb(db);
  console.log(`[nexus] Admin seeded → ${config.adminEmail}`);
}
await seedAdmin();

// ── Health ─────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "nexus-deploy", version: "0.2.0", time: new Date().toISOString() });
});

// ── Auth ───────────────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: "Missing email or password" });
  const db = loadDb();
  if (!config.allowRegistration && db.users.length > 0)
    return res.status(403).json({ error: "Registration disabled" });
  if (db.users.some(u => u.email.toLowerCase() === String(email).toLowerCase()))
    return res.status(409).json({ error: "Account exists" });
  const passwordHash = await hashPassword(String(password));
  const user: User = { id: newId("usr"), email: String(email), passwordHash, role: db.users.length ? "member" : "owner", createdAt: Date.now() };
  db.users.push(user);
  saveDb(db);
  res.json({ token: createToken(user), user: publicUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  const db = loadDb();
  const user = db.users.find(u => u.email.toLowerCase() === String(email ?? "").toLowerCase());
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const ok = await verifyPassword(String(password ?? ""), user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });
  res.json({ token: createToken(user), user: publicUser(user) });
});

app.get("/api/me", requireAuth, (req: AuthedRequest, res) => {
  const user = loadDb().users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json({ user: publicUser(user) });
});

// ── Projects ───────────────────────────────────────────────────────────────
app.get("/api/projects", requireAuth, (_req, res) => {
  const db = loadDb();
  const projects = db.projects.map(p => ({
    ...p,
    latestDeployment: db.deployments.find(d => d.projectId === p.id) ?? null,
  }));
  res.json({ projects });
});

app.post("/api/projects", requireAuth, async (req, res) => {
  const { name, repo, branch, buildCommand, startCommand, volumePath, port } = req.body ?? {};
  if (!name || !repo) return res.status(400).json({ error: "Missing name or repo" });
  const db = loadDb();
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  if (db.projects.some(p => p.name === slug))
    return res.status(409).json({ error: "Project name already taken" });
  const project: Project = {
    id: newId("prj"),
    name: slug,
    repo: String(repo),
    branch: String(branch ?? "main"),
    buildCommand: String(buildCommand ?? "npm run build"),
    startCommand: String(startCommand ?? "npm start"),
    volumePath: String(volumePath ?? "/workspace"),
    port: Number(port ?? 3000),
    env: {},
    status: "idle",
    webhookSecret: crypto.randomBytes(24).toString("hex"),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.projects.unshift(project);
  saveDb(db);
  res.status(201).json({ project });
});

app.get("/api/projects/:id", requireAuth, (req, res) => {
  const db = loadDb();
  const project = db.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  const deployments = db.deployments.filter(d => d.projectId === project.id);
  res.json({ project, deployments });
});

app.put("/api/projects/:id", requireAuth, async (req, res) => {
  const { repo, branch, buildCommand, startCommand, volumePath, port } = req.body ?? {};
  await writeDb(db => {
    const project = db.projects.find(p => p.id === req.params.id);
    if (!project) return;
    if (repo !== undefined) project.repo = String(repo);
    if (branch !== undefined) project.branch = String(branch);
    if (buildCommand !== undefined) project.buildCommand = String(buildCommand);
    if (startCommand !== undefined) project.startCommand = String(startCommand);
    if (volumePath !== undefined) project.volumePath = String(volumePath);
    if (port !== undefined) project.port = Number(port);
    project.updatedAt = Date.now();
  });
  const updated = loadDb().projects.find(p => p.id === req.params.id);
  if (!updated) return res.status(404).json({ error: "Not found" });
  res.json({ project: updated });
});

app.delete("/api/projects/:id", requireAuth, async (req, res) => {
  const db = loadDb();
  const project = db.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  await dockerRemove(`nexus-app-${project.name}`).catch(() => {});
  await writeDb(db => {
    db.projects = db.projects.filter(p => p.id !== req.params.id);
    db.deployments = db.deployments.filter(d => d.projectId !== req.params.id);
  });
  res.json({ ok: true });
});

// ── Webhook secret regen ───────────────────────────────────────────────────
app.post("/api/projects/:id/regen-webhook-secret", requireAuth, async (req, res) => {
  const secret = crypto.randomBytes(24).toString("hex");
  await writeDb(db => {
    const p = db.projects.find(p => p.id === req.params.id);
    if (p) { p.webhookSecret = secret; p.updatedAt = Date.now(); }
  });
  res.json({ webhookSecret: secret });
});

// ── Env vars ───────────────────────────────────────────────────────────────
app.put("/api/projects/:id/env", requireAuth, async (req, res) => {
  const { env } = req.body ?? {};
  if (typeof env !== "object" || env === null) return res.status(400).json({ error: "env must be an object" });
  await writeDb(db => {
    const p = db.projects.find(p => p.id === req.params.id);
    if (p) { p.env = env; p.updatedAt = Date.now(); }
  });
  const updated = loadDb().projects.find(p => p.id === req.params.id);
  res.json({ project: updated });
});

// ── Container health check ─────────────────────────────────────────────────
app.get("/api/projects/:id/health", requireAuth, async (req, res) => {
  const project = loadDb().projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  if (!project.containerId) return res.json({ healthy: false, reason: "No container" });
  const status = await dockerStatus(`nexus-app-${project.name}`);
  const healthy = status === "running";
  // If project is live but container is gone — correct it
  if (!healthy && project.status === "live") {
    await writeDb(db => {
      const p = db.projects.find(p => p.id === req.params.id);
      if (p) { p.status = "stopped"; p.updatedAt = Date.now(); }
    });
  }
  res.json({ healthy, dockerStatus: status });
});

// ── Deploy ─────────────────────────────────────────────────────────────────
app.post("/api/projects/:id/deploy", requireAuth, (req, res) => {
  const project = loadDb().projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  if (isBuilding(project.id)) return res.status(409).json({ error: "Build already in progress" });
  const { commitSha } = req.body ?? {};
  const deployment = createDeployment(project, String(commitSha ?? "manual"), "manual");
  runDeploy(project, deployment.id).catch(err =>
    console.error(`[nexus] deploy error (${project.name}):`, err.message)
  );
  res.json({ deployment });
});

// ── Rollback ───────────────────────────────────────────────────────────────
app.post("/api/deployments/:id/rollback", requireAuth, async (req, res) => {
  const db = loadDb();
  const source = db.deployments.find(d => d.id === req.params.id);
  if (!source) return res.status(404).json({ error: "Deployment not found" });
  if (!source.imageTag) return res.status(400).json({ error: "No image — cannot roll back" });
  const project = db.projects.find(p => p.id === source.projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (isBuilding(project.id)) return res.status(409).json({ error: "Build in progress" });

  const dep = createDeployment(project, `rollback:${source.commitSha.slice(0, 8)}`, "rollback");
  await writeDb(d => {
    const found = d.deployments.find(x => x.id === dep.id);
    if (found) found.imageTag = source.imageTag;
  });
  runRollback(project, dep.id, source.imageTag).catch(() => {});
  res.json({ deployment: dep });
});

// ── Stop / start ───────────────────────────────────────────────────────────
app.post("/api/projects/:id/stop", requireAuth, async (req, res) => {
  const project = loadDb().projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  await dockerStop(`nexus-app-${project.name}`);
  await writeDb(db => {
    const p = db.projects.find(p => p.id === req.params.id);
    if (p) { p.status = "stopped"; p.updatedAt = Date.now(); }
  });
  res.json({ ok: true });
});

app.post("/api/projects/:id/start", requireAuth, async (req, res) => {
  const project = loadDb().projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  await dockerStart(`nexus-app-${project.name}`);
  await writeDb(db => {
    const p = db.projects.find(p => p.id === req.params.id);
    if (p) { p.status = "live"; p.updatedAt = Date.now(); }
  });
  res.json({ ok: true });
});

// ── Deployments & logs ─────────────────────────────────────────────────────
app.get("/api/deployments", requireAuth, (_req, res) => {
  const db = loadDb();
  const enriched = db.deployments.slice(0, 100).map(d => ({
    ...d,
    projectName: db.projects.find(p => p.id === d.projectId)?.name ?? "deleted",
  }));
  res.json({ deployments: enriched });
});

app.get("/api/deployments/:id/logs", requireAuth, (req, res) => {
  const d = loadDb().deployments.find(d => d.id === req.params.id);
  if (!d) return res.status(404).json({ error: "Not found" });
  res.json({ logs: d.logs, status: d.status });
});

// ── Activity feed ──────────────────────────────────────────────────────────
app.get("/api/activity", requireAuth, (_req, res) => {
  const db = loadDb();
  const activity = db.deployments.slice(0, 25).map(d => ({
    id: d.id,
    projectId: d.projectId,
    projectName: db.projects.find(p => p.id === d.projectId)?.name ?? "deleted",
    commitSha: d.commitSha,
    triggeredBy: d.triggeredBy,
    status: d.status,
    createdAt: d.createdAt,
    finishedAt: d.finishedAt,
  }));
  res.json({ activity });
});

// ── GitHub Webhook ─────────────────────────────────────────────────────────
app.post("/api/webhooks/github/:projectId", express.raw({ type: "*/*" }), async (req, res) => {
  const project = loadDb().projects.find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const secret = project.webhookSecret;
  const sig = req.headers["x-hub-signature-256"] as string | undefined;
  if (secret && sig) {
    const expected = `sha256=${crypto.createHmac("sha256", secret).update(req.body).digest("hex")}`;
    try {
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
        return res.status(401).json({ error: "Invalid signature" });
    } catch {
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  let payload: any;
  try { payload = JSON.parse(req.body.toString()); } catch { return res.status(400).json({ error: "Bad payload" }); }

  const branch = (payload?.ref as string | undefined)?.replace("refs/heads/", "");
  if (branch && branch !== project.branch)
    return res.json({ ok: true, skipped: `branch ${branch} ≠ ${project.branch}` });

  if (isBuilding(project.id))
    return res.json({ ok: true, skipped: "build already in progress" });

  const sha = payload?.after ?? "webhook";
  const deployment = createDeployment(project, String(sha), "webhook");
  runDeploy(project, deployment.id).catch(() => {});
  res.json({ ok: true, deploymentId: deployment.id });
});

// ── Static dashboard ───────────────────────────────────────────────────────
app.use(express.static("web/dist"));
app.get("*", (_req, res) => { res.sendFile(process.cwd() + "/web/dist/index.html"); });

// ── WebSocket log stream ───────────────────────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/api/log-stream" });

wss.on("connection", (socket: WebSocket, req) => {
  const url = new URL(req.url ?? "", "http://localhost");
  const deploymentId = url.searchParams.get("deploymentId");
  const token = url.searchParams.get("token");

  try { if (!token) throw new Error(); verifyToken(token); }
  catch { socket.close(1008, "Unauthorized"); return; }

  if (!deploymentId) { socket.close(1008, "Missing deploymentId"); return; }

  const dep = loadDb().deployments.find(d => d.id === deploymentId);
  if (dep) {
    for (const line of dep.logs) socket.send(JSON.stringify({ type: "log", line }));
    if (dep.status === "live" || dep.status === "failed") {
      socket.send(JSON.stringify({ type: "done", status: dep.status }));
      socket.close(); return;
    }
  }

  const unsub = subscribeToDeployment(deploymentId, line => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "log", line }));
    const d = loadDb().deployments.find(d => d.id === deploymentId);
    if (d?.status === "live" || d?.status === "failed") {
      socket.send(JSON.stringify({ type: "done", status: d.status }));
      socket.close();
    }
  });

  const hb = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    else clearInterval(hb);
  }, 15_000);

  socket.on("close", () => { unsub(); clearInterval(hb); });
});

// ── Boot ───────────────────────────────────────────────────────────────────
startStatusSync(30_000);

server.listen(config.port, () => {
  console.log(`
╔════════════════════════════════════════╗
║        NEXUS DEPLOY  v0.2.0           ║
║   The No Hands Company · Free forever ║
╠════════════════════════════════════════╣
║  ${config.baseUrl.padEnd(38)}║
║  *.${config.baseDomain.padEnd(36)}║
╚════════════════════════════════════════╝
  `);
});
