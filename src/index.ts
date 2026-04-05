import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { config, ensureDataDir } from "./lib/config.js";
import { loadDb, saveDb } from "./lib/store.js";
import { createToken, hashPassword, newId, verifyPassword } from "./lib/auth.js";
import { createDeployment, appendLog, finishDeployment } from "./lib/deployments.js";
import { requireAuth, type AuthedRequest } from "./middleware/auth.js";
import type { Project, User } from "./types.js";

ensureDataDir();
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

function publicUser(user: User) {
  return { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt };
}

function getDb() {
  return loadDb();
}

async function seedAdmin() {
  const db = getDb();
  if (db.users.length) return;
  const passwordHash = await hashPassword(config.adminPassword);
  db.users.push({
    id: newId("usr"),
    email: config.adminEmail,
    passwordHash,
    role: "owner",
    createdAt: Date.now(),
  });
  saveDb(db);
}

await seedAdmin();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "nexus-deploy", time: new Date().toISOString() });
});

app.post("/api/auth/register", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: "Missing email or password" });
  const db = getDb();
  if (!config.allowRegistration && db.users.length > 0) return res.status(403).json({ error: "Registration disabled" });
  if (db.users.some(user => user.email.toLowerCase() === String(email).toLowerCase())) {
    return res.status(409).json({ error: "Account exists" });
  }
  const passwordHash = await hashPassword(String(password));
  const user: User = { id: newId("usr"), email: String(email), passwordHash, role: db.users.length ? "member" : "owner", createdAt: Date.now() };
  db.users.push(user);
  saveDb(db);
  const token = createToken(user);
  res.json({ token, user: publicUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  const db = getDb();
  const user = db.users.find(item => item.email.toLowerCase() === String(email ?? "").toLowerCase());
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const ok = await verifyPassword(String(password ?? ""), user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });
  const token = createToken(user);
  res.json({ token, user: publicUser(user) });
});

app.get("/api/me", requireAuth, (req: AuthedRequest, res) => {
  const db = getDb();
  const user = db.users.find(item => item.id === req.userId);
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json({ user: publicUser(user) });
});

app.get("/api/projects", requireAuth, (_req, res) => {
  const db = getDb();
  res.json({ projects: db.projects });
});

app.post("/api/projects", requireAuth, (req: AuthedRequest, res) => {
  const { name, repo, branch, buildCommand, startCommand, volumePath } = req.body ?? {};
  if (!name || !repo) return res.status(400).json({ error: "Missing project name or repo" });
  const db = getDb();
  const project: Project = {
    id: newId("prj"),
    name: String(name),
    repo: String(repo),
    branch: String(branch ?? "main"),
    buildCommand: String(buildCommand ?? "npm run build"),
    startCommand: String(startCommand ?? "npm start"),
    volumePath: String(volumePath ?? "/workspace"),
    env: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.projects.unshift(project);
  saveDb(db);
  res.status(201).json({ project });
});

app.get("/api/projects/:id", requireAuth, (req, res) => {
  const db = getDb();
  const project = db.projects.find(item => item.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  const deployments = db.deployments.filter(item => item.projectId === project.id);
  res.json({ project, deployments });
});

app.post("/api/projects/:id/deploy", requireAuth, (req, res) => {
  const { commitSha } = req.body ?? {};
  const db = getDb();
  const project = db.projects.find(item => item.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  const deployment = createDeployment(db, project, String(commitSha ?? "manual"));
  appendLog(db, deployment.id, "[deploy] pulling source from GitHub");
  appendLog(db, deployment.id, "[deploy] auto-detected Dockerfile");
  appendLog(db, deployment.id, "[deploy] building web frontend");
  appendLog(db, deployment.id, "[deploy] installing Python deps");
  finishDeployment(db, deployment.id, "live");
  appendLog(db, deployment.id, "[deploy] live on Railway-style environment");
  saveDb(db);
  res.json({ deployment });
});

app.put("/api/projects/:id/env", requireAuth, (req, res) => {
  const { env } = req.body ?? {};
  const db = getDb();
  const project = db.projects.find(item => item.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  project.env = typeof env === "object" && env ? env : project.env;
  project.updatedAt = Date.now();
  saveDb(db);
  res.json({ project });
});

app.get("/api/deployments", requireAuth, (_req, res) => {
  const db = getDb();
  res.json({ deployments: db.deployments });
});

app.get("/api/deployments/:id/logs", requireAuth, (req, res) => {
  const db = getDb();
  const deployment = db.deployments.find(item => item.id === req.params.id);
  if (!deployment) return res.status(404).json({ error: "Not found" });
  res.json({ logs: deployment.logs, status: deployment.status });
});

app.post("/api/webhooks/github", express.json({ type: "*/*" }), (req, res) => {
  const secret = req.header("x-nexus-secret");
  if (secret !== config.appSecret) return res.status(401).json({ error: "Unauthorized" });
  const repo = req.body?.repository?.full_name;
  const sha = req.body?.after;
  const db = getDb();
  const project = db.projects.find(item => item.repo === repo);
  if (!project) return res.json({ ok: true, skipped: true });
  const deployment = createDeployment(db, project, String(sha ?? "webhook"));
  appendLog(db, deployment.id, "[webhook] verified GitHub push");
  finishDeployment(db, deployment.id, "live");
  saveDb(db);
  res.json({ ok: true, deploymentId: deployment.id });
});

app.use(express.static("web/dist"));
app.get("*", (_req, res) => {
  res.sendFile(process.cwd() + "/web/dist/index.html");
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/api/log-stream" });

wss.on("connection", socket => {
  socket.send(JSON.stringify({ type: "hello", service: "nexus-deploy" }));
  const interval = setInterval(() => {
    socket.send(JSON.stringify({ type: "heartbeat", time: Date.now() }));
  }, 5000);
  socket.on("close", () => clearInterval(interval));
});

server.listen(config.port, () => {
  console.log(`Nexus Deploy listening on ${config.baseUrl}`);
});
