import express from "express";
import cors from "cors";
import helmet from "helmet";
import crypto from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { config, ensureDataDir } from "./lib/config.js";
import { loadDb, saveDb } from "./lib/store.js";
import { createToken, hashPassword, newId, verifyPassword, verifyToken } from "./lib/auth.js";
import { createDeployment, runDeploy, subscribeToDeployment } from "./lib/build.js";
import { dockerStop, dockerStart, dockerRemove, dockerStatus } from "./lib/docker.js";
import { requireAuth, type AuthedRequest } from "./middleware/auth.js";
import type { Project, User } from "./types.js";

ensureDataDir();
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

function publicUser(user: User) {
  return { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt };
}
function getDb() { return loadDb(); }

// ── Seed admin ─────────────────────────────────────────────────────────────
async function seedAdmin() {
  const db = getDb();
  if (db.users.length) return;
  const passwordHash = await hashPassword(config.adminPassword);
  db.users.push({ id: newId("usr"), email: config.adminEmail, passwordHash, role: "owner", createdAt: Date.now() });
  saveDb(db);
}
await seedAdmin();

// ── Health ─────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "nexus-deploy", version: "0.1.0", time: new Date().toISOString() });
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
  // Attach latest deployment to each project
  const projects = db.projects.map(p => ({
    ...p,
    latestDeployment: db.deployments.find(d => d.projectId === p.id) ?? null,
  }));
  res.json({ projects });
});

app.post("/api/projects", requireAuth, (req: AuthedRequest, res) => {
  const { name, repo, branch, buildCommand, startCommand, volumePath } = req.body ?? {};
  if (!name || !repo) return res.status(400).json({ error: "Missing project name or repo" });
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
  if (repo) project.repo = String(repo);
  if (branch) project.branch = String(branch);
  if (buildCommand) project.buildCommand = String(buildCommand);
  if (startCommand) project.startCommand = String(startCommand);
  if (volumePath) project.volumePath = String(volumePath);
  project.updatedAt = Date.now();
  saveDb(db);
  res.json({ project });
});

app.delete("/api/projects/:id", requireAuth, async (req, res) => {
  const db = getDb();
  const idx = db.projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  const project = db.projects[idx];
  // Stop and remove container
  if (project.containerId) {
    await dockerRemove(`nexus-app-${project.name}`).catch(() => {});
  }
  db.projects.splice(idx, 1);
  db.deployments = db.deployments.filter(d => d.projectId !== project.id);
  saveDb(db);
  res.json({ ok: true });
});

// ── Deploy ─────────────────────────────────────────────────────────────────
app.post("/api/projects/:id/deploy", requireAuth, async (req, res) => {
  const db = getDb();
  const project = db.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });

  const { commitSha } = req.body ?? {};
  const deployment = createDeployment(project, String(commitSha ?? "manual"), "manual");

  // Fire-and-forget — caller watches logs via WebSocket
  runDeploy(project, deployment.id).catch(err => {
    console.error(`[nexus] Deploy failed for ${project.name}:`, err.message);
  });

  res.json({ deployment });
});

// ── Container control ──────────────────────────────────────────────────────
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

// ── Env vars ───────────────────────────────────────────────────────────────
app.put("/api/projects/:id/env", requireAuth, (req, res) => {
  const { env } = req.body ?? {};
  const db = getDb();
  const project = db.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  project.env = typeof env === "object" && env ? env : project.env;
  project.updatedAt = Date.now();
  saveDb(db);
  res.json({ project });
});

// ── Deployments ────────────────────────────────────────────────────────────
app.get("/api/deployments", requireAuth, (_req, res) => {
  res.json({ deployments: getDb().deployments });
});

app.get("/api/deployments/:id", requireAuth, (req, res) => {
  const deployment = getDb().deployments.find(d => d.id === req.params.id);
  if (!deployment) return res.status(404).json({ error: "Not found" });
  res.json({ deployment });
});

app.get("/api/deployments/:id/logs", requireAuth, (req, res) => {
  const deployment = getDb().deployments.find(d => d.id === req.params.id);
  if (!deployment) return res.status(404).json({ error: "Not found" });
  res.json({ logs: deployment.logs, status: deployment.status });
});

// ── GitHub Webhook ─────────────────────────────────────────────────────────
app.post("/api/webhooks/github", express.raw({ type: "*/*" }), (req, res) => {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  const sig = req.headers["x-hub-signature-256"] as string | undefined;

  if (webhookSecret && sig) {
    const expected = `sha256=${crypto.createHmac("sha256", webhookSecret).update(req.body).digest("hex")}`;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
      return res.status(401).json({ error: "Invalid signature" });
  }

  let payload: any;
  try { payload = JSON.parse(req.body.toString()); } catch { return res.status(400).json({ error: "Bad payload" }); }

  const repoFull = payload?.repository?.full_name;
  const sha = payload?.after;
  const ref = payload?.ref as string | undefined;
  const branch = ref?.replace("refs/heads/", "");

  const db = getDb();
  const project = db.projects.find(p => {
    const repoMatch = p.repo.includes(repoFull) || p.repo === repoFull;
    const branchMatch = !branch || p.branch === branch;
    return repoMatch && branchMatch;
  });

  if (!project) return res.json({ ok: true, skipped: true });

  const deployment = createDeployment(project, String(sha ?? "webhook"), "webhook");
  runDeploy(project, deployment.id).catch(() => {});
  res.json({ ok: true, deploymentId: deployment.id });
});

// ── Static dashboard ───────────────────────────────────────────────────────
app.use(express.static("web/dist"));
app.get("*", (_req, res) => {
  res.sendFile(process.cwd() + "/web/dist/index.html");
});

// ── HTTP + WebSocket server ────────────────────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/api/log-stream" });

wss.on("connection", (socket: WebSocket, req) => {
  const url = new URL(req.url ?? "", `http://localhost`);
  const deploymentId = url.searchParams.get("deploymentId");
  const token = url.searchParams.get("token");

  // Verify token
  try {
    if (token) verifyToken(token);
    else throw new Error("no token");
  } catch {
    socket.close(1008, "Unauthorized");
    return;
  }

  if (!deploymentId) {
    socket.close(1008, "Missing deploymentId");
    return;
  }

  // Send historical logs first
  const deployment = getDb().deployments.find(d => d.id === deploymentId);
  if (deployment) {
    for (const line of deployment.logs) {
      socket.send(JSON.stringify({ type: "log", line }));
    }
    if (deployment.status === "live" || deployment.status === "failed") {
      socket.send(JSON.stringify({ type: "done", status: deployment.status }));
      socket.close();
      return;
    }
  }

  // Subscribe to live stream
  const unsub = subscribeToDeployment(deploymentId, (line) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "log", line }));

      // Check if done
      const dep = getDb().deployments.find(d => d.id === deploymentId);
      if (dep?.status === "live" || dep?.status === "failed") {
        socket.send(JSON.stringify({ type: "done", status: dep.status }));
        socket.close();
      }
    }
  });

  socket.on("close", unsub);

  // Heartbeat
  const hb = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    else clearInterval(hb);
  }, 10000);
  socket.on("close", () => clearInterval(hb));
});

server.listen(config.port, () => {
  console.log(`
╔═══════════════════════════════════════╗
║       NEXUS DEPLOY  v0.1.0           ║
║  The No Hands Company                ║
╠═══════════════════════════════════════╣
║  ${config.baseUrl.padEnd(37)}║
╚═══════════════════════════════════════╝
  `);
});
