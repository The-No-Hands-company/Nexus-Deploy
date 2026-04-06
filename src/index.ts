import express from "express";
import cors from "cors";
import helmet from "helmet";
import crypto from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { config, ensureDataDir } from "./lib/config.js";
import { loadDb, saveDb } from "./lib/store.js";
import { createToken, hashPassword, newId, verifyPassword, verifyToken } from "./lib/auth.js";
import { createDeployment, runDeploy, runRollback, subscribeToDeployment } from "./lib/build.js";
import { dockerStop, dockerStart, dockerRemove } from "./lib/docker.js";
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
function getDb() { return loadDb(); }

// ── Seed admin ─────────────────────────────────────────────────────────────
async function seedAdmin() {
  const db = getDb();
  if (db.users.length) return;
  const passwordHash = await hashPassword(config.adminPassword);
  db.users.push({ id: newId("usr"), email: config.adminEmail, passwordHash, role: "owner", createdAt: Date.now() });
  saveDb(db);
  console.log(`[nexus] Admin seeded: ${config.adminEmail}`);
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
  const db = getDb();
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
  const db = getDb();
  const user = db.users.find(u => u.email.toLowerCase() === String(email ?? "").toLowerCase());
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const ok = await verifyPassword(String(password ?? ""), user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });
  res.json({ token: createToken(user), user: publicUser(user) });
});

app.get("/api/me", requireAuth, (req: AuthedRequest, res) => {
  const user = getDb().users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json({ user: publicUser(user) });
});

// ── Projects ───────────────────────────────────────────────────────────────
app.get("/api/projects", requireAuth, (_req, res) => {
  const db = getDb();
  const projects = db.projects.map(p => ({
    ...p,
    latestDeployment: db.deployments.find(d => d.projectId === p.id) ?? null,
  }));
  res.json({ projects });
});

app.post("/api/projects", requireAuth, (req, res) => {
  const { name, repo, branch, buildCommand, startCommand, volumePath } = req.body ?? {};
  if (!name || !repo) return res.status(400).json({ error: "Missing name or repo" });
  const db = getDb();
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
  const db = getDb();
  const project = db.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  const deployments = db.deployments.filter(d => d.projectId === project.id);
  res.json({ project, deployments });
});

app.put("/api/projects/:id", requireAuth, (req, res) => {
  const { repo, branch, buildCommand, startCommand, volumePath } = req.body ?? {};
  const db = getDb();
  const project = db.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  if (repo !== undefined) project.repo = String(repo);
  if (branch !== undefined) project.branch = String(branch);
  if (buildCommand !== undefined) project.buildCommand = String(buildCommand);
  if (startCommand !== undefined) project.startCommand = String(startCommand);
  if (volumePath !== undefined) project.volumePath = String(volumePath);
  project.updatedAt = Date.now();
  saveDb(db);
  res.json({ project });
});

app.delete("/api/projects/:id", requireAuth, async (req, res) => {
  const db = getDb();
  const idx = db.projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  const project = db.projects[idx];
  await dockerRemove(`nexus-app-${project.name}`).catch(() => {});
  db.projects.splice(idx, 1);
  db.deployments = db.deployments.filter(d => d.projectId !== project.id);
  saveDb(db);
  res.json({ ok: true });
});

// ── Regenerate webhook secret ──────────────────────────────────────────────
app.post("/api/projects/:id/regen-webhook-secret", requireAuth, (req, res) => {
  const db = getDb();
  const project = db.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  project.webhookSecret = crypto.randomBytes(24).toString("hex");
  project.updatedAt = Date.now();
  saveDb(db);
  res.json({ webhookSecret: project.webhookSecret });
});

// ── Env vars ───────────────────────────────────────────────────────────────
app.put("/api/projects/:id/env", requireAuth, (req, res) => {
  const { env } = req.body ?? {};
  const db = getDb();
  const project = db.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  project.env = typeof env === "object" && env !== null ? env : project.env;
  project.updatedAt = Date.now();
  saveDb(db);
  res.json({ project });
});

// ── Deploy ─────────────────────────────────────────────────────────────────
app.post("/api/projects/:id/deploy", requireAuth, async (req, res) => {
  const db = getDb();
  const project = db.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  if (project.status === "building")
    return res.status(409).json({ error: "A build is already in progress" });
  const { commitSha } = req.body ?? {};
  const deployment = createDeployment(project, String(commitSha ?? "manual"), "manual");
  runDeploy(project, deployment.id).catch(err =>
    console.error(`[nexus] deploy error (${project.name}):`, err.message)
  );
  res.json({ deployment });
});

// ── Rollback ───────────────────────────────────────────────────────────────
app.post("/api/deployments/:id/rollback", requireAuth, async (req, res) => {
  const db = getDb();
  const source = db.deployments.find(d => d.id === req.params.id);
  if (!source) return res.status(404).json({ error: "Deployment not found" });
  if (!source.imageTag) return res.status(400).json({ error: "No image tag on this deployment — cannot roll back" });

  const project = db.projects.find(p => p.id === source.projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.status === "building") return res.status(409).json({ error: "Build in progress" });

  const rollbackDep = createDeployment(project, `rollback:${source.commitSha.slice(0, 8)}`, "rollback");

  // Persist the imageTag immediately so the rollback has it
  const db2 = loadDb();
  const dep2 = db2.deployments.find(d => d.id === rollbackDep.id);
  if (dep2) { dep2.imageTag = source.imageTag; saveDb(db2); }

  runRollback(project, rollbackDep.id, source.imageTag).catch(err =>
    console.error(`[nexus] rollback error (${project.name}):`, err.message)
  );

  res.json({ deployment: rollbackDep });
});

// ── Container stop / start ─────────────────────────────────────────────────
app.post("/api/projects/:id/stop", requireAuth, async (req, res) => {
  const db = getDb();
  const project = db.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  await dockerStop(`nexus-app-${project.name}`);
  project.status = "stopped";
  project.updatedAt = Date.now();
  saveDb(db);
  res.json({ ok: true });
});

app.post("/api/projects/:id/start", requireAuth, async (req, res) => {
  const db = getDb();
  const project = db.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  await dockerStart(`nexus-app-${project.name}`);
  project.status = "live";
  project.updatedAt = Date.now();
  saveDb(db);
  res.json({ ok: true });
});

// ── Deployments ────────────────────────────────────────────────────────────
app.get("/api/deployments", requireAuth, (_req, res) => {
  const db = getDb();
  // Return last 100 across all projects, with project name attached
  const enriched = db.deployments.slice(0, 100).map(d => {
    const proj = db.projects.find(p => p.id === d.projectId);
    return { ...d, projectName: proj?.name ?? "deleted" };
  });
  res.json({ deployments: enriched });
});

app.get("/api/deployments/:id", requireAuth, (req, res) => {
  const d = getDb().deployments.find(d => d.id === req.params.id);
  if (!d) return res.status(404).json({ error: "Not found" });
  res.json({ deployment: d });
});

app.get("/api/deployments/:id/logs", requireAuth, (req, res) => {
  const d = getDb().deployments.find(d => d.id === req.params.id);
  if (!d) return res.status(404).json({ error: "Not found" });
  res.json({ logs: d.logs, status: d.status });
});

// ── Activity feed ──────────────────────────────────────────────────────────
app.get("/api/activity", requireAuth, (_req, res) => {
  const db = getDb();
  const activity = db.deployments.slice(0, 20).map(d => {
    const proj = db.projects.find(p => p.id === d.projectId);
    return {
      id: d.id,
      projectId: d.projectId,
      projectName: proj?.name ?? "deleted",
      commitSha: d.commitSha,
      triggeredBy: d.triggeredBy,
      status: d.status,
      createdAt: d.createdAt,
      finishedAt: d.finishedAt,
    };
  });
  res.json({ activity });
});

// ── GitHub Webhook ─────────────────────────────────────────────────────────
app.post("/api/webhooks/github/:projectId", express.raw({ type: "*/*" }), async (req, res) => {
  const db = getDb();
  const project = db.projects.find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  // Verify per-project webhook secret
  const secret = project.webhookSecret;
  const sig = req.headers["x-hub-signature-256"] as string | undefined;

  if (secret && sig) {
    const expected = `sha256=${crypto.createHmac("sha256", secret).update(req.body).digest("hex")}`;
    try {
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
        return res.status(401).json({ error: "Invalid signature" });
    } catch { return res.status(401).json({ error: "Invalid signature" }); }
  }

  let payload: any;
  try { payload = JSON.parse(req.body.toString()); } catch { return res.status(400).json({ error: "Bad payload" }); }

  const ref = payload?.ref as string | undefined;
  const branch = ref?.replace("refs/heads/", "");
  if (branch && branch !== project.branch) return res.json({ ok: true, skipped: `branch ${branch} != ${project.branch}` });

  if (project.status === "building") return res.json({ ok: true, skipped: "build in progress" });

  const sha = payload?.after ?? "webhook";
  const deployment = createDeployment(project, String(sha), "webhook");
  runDeploy(project, deployment.id).catch(() => {});
  res.json({ ok: true, deploymentId: deployment.id });
});

// ── Static dashboard ───────────────────────────────────────────────────────
app.use(express.static("web/dist"));
app.get("*", (_req, res) => { res.sendFile(process.cwd() + "/web/dist/index.html"); });

// ── HTTP + WebSocket ───────────────────────────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/api/log-stream" });

wss.on("connection", (socket: WebSocket, req) => {
  const url = new URL(req.url ?? "", "http://localhost");
  const deploymentId = url.searchParams.get("deploymentId");
  const token = url.searchParams.get("token");

  try {
    if (!token) throw new Error("no token");
    verifyToken(token);
  } catch { socket.close(1008, "Unauthorized"); return; }

  if (!deploymentId) { socket.close(1008, "Missing deploymentId"); return; }

  const dep = getDb().deployments.find(d => d.id === deploymentId);
  if (dep) {
    for (const line of dep.logs) {
      socket.send(JSON.stringify({ type: "log", line }));
    }
    if (dep.status === "live" || dep.status === "failed") {
      socket.send(JSON.stringify({ type: "done", status: dep.status }));
      socket.close();
      return;
    }
  }

  const unsub = subscribeToDeployment(deploymentId, (line) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "log", line }));
    const d = getDb().deployments.find(d => d.id === deploymentId);
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
╔═══════════════════════════════════════╗
║       NEXUS DEPLOY  v0.2.0           ║
║  The No Hands Company                ║
╠═══════════════════════════════════════╣
║  ${config.baseUrl.padEnd(37)}║
║  domain: *.${config.baseDomain.padEnd(26)}║
╚═══════════════════════════════════════╝
  `);
});
