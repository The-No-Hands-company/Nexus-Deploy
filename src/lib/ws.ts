/**
 * Live streams over WebSocket: a build's log, and a running container's output.
 *
 * A browser cannot put an Authorization header on a WebSocket, so the credential
 * arrives as `?token=`. It goes through exactly the same checks as an HTTP
 * request — identity, membership, ownership — because an upgrade must not be a
 * cheaper way in.
 */
import type { Server } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { verifyWithNexusAuth } from "../middleware/auth.js";
import type { AppDeps } from "../routes/types.js";
import { subscribeToDeployment } from "./build.js";
import { containerNameOf } from "./containers.js";
import { canAccessProject, resolveAccess } from "./members.js";
import { loadDb } from "./store.js";

const HEARTBEAT_MS = 15_000;

async function accessFor(token: string | null, deps: AppDeps) {
  if (!token) return null;
  const identity = await verifyWithNexusAuth(token, deps.authenticate);
  if (!identity) return null;
  const access = resolveAccess(loadDb().members, identity);
  return access.ok ? access : null;
}

function keepAlive(socket: WebSocket): () => void {
  const timer = setInterval(() => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}

export function attachSockets(server: Server, deps: AppDeps): void {
  // Two WebSocketServers attached directly to one HTTP server both answer every
  // upgrade request, so the one whose path does not match rejects the connection
  // the other has just accepted. Each is therefore detached (`noServer`) and one
  // handler below routes upgrades by path.
  const buildLogs = new WebSocketServer({ noServer: true });
  const containerLogs = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "", "http://localhost");
    const target =
      pathname === "/api/log-stream" ? buildLogs : pathname === "/api/container-stream" ? containerLogs : null;
    if (!target) {
      socket.destroy();
      return;
    }
    target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
  });

  // ── A build's log ────────────────────────────────────────────────────────
  buildLogs.on("connection", async (socket, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const access = await accessFor(url.searchParams.get("token"), deps);
    if (!access) return void socket.close(1008, "Unauthorized");

    const deploymentId = url.searchParams.get("deploymentId");
    if (!deploymentId) return void socket.close(1008, "Missing deploymentId");
    const dep = loadDb().deployments.find((d) => d.id === deploymentId);
    const project = dep && loadDb().projects.find((p) => p.id === dep.projectId);
    // Someone else's build answers exactly like one that does not exist.
    if (!dep || !project || !canAccessProject(project, access)) return void socket.close(1008, "Not found");

    for (const line of dep.logs) socket.send(JSON.stringify({ type: "log", line }));
    if (dep.status === "live" || dep.status === "failed" || dep.status === "cancelled") {
      socket.send(JSON.stringify({ type: "done", status: dep.status }));
      return void socket.close();
    }

    const unsubscribe = subscribeToDeployment(deploymentId, (line) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({ type: "log", line }));
      const current = loadDb().deployments.find((d) => d.id === deploymentId);
      if (current && (current.status === "live" || current.status === "failed" || current.status === "cancelled")) {
        socket.send(JSON.stringify({ type: "done", status: current.status }));
        socket.close();
      }
    });
    const stopBeat = keepAlive(socket);
    socket.on("close", () => {
      unsubscribe();
      stopBeat();
    });
  });

  // ── A running container's output ─────────────────────────────────────────
  containerLogs.on("connection", async (socket, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const access = await accessFor(url.searchParams.get("token"), deps);
    if (!access) return void socket.close(1008, "Unauthorized");

    const projectId = url.searchParams.get("projectId");
    const project = projectId ? loadDb().projects.find((p) => p.id === projectId) : undefined;
    if (!project || !canAccessProject(project, access)) return void socket.close(1008, "Not found");

    const name = containerNameOf(project);
    let closed = false;
    socket.send(JSON.stringify({ type: "info", line: `[nexus] Streaming logs from ${name}…` }));

    const stopLogs = deps.ops.logs(
      name,
      (line) => {
        if (!closed && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "log", line }));
      },
      (err) => {
        if (!closed && socket.readyState === socket.OPEN) {
          if (err) socket.send(JSON.stringify({ type: "error", line: `[nexus] ${err.message}` }));
          socket.close();
        }
      },
    );
    const stopBeat = keepAlive(socket);
    socket.on("close", () => {
      closed = true;
      stopBeat();
      stopLogs();
    });
  });
}
