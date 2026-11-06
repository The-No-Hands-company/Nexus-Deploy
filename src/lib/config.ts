import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePortRange } from "./hosts.js";
import { limitsFromEnv } from "./safeguards.js";

// Default the data root somewhere the running user can actually write.
//
// This used to default to "/workspace", a path at the filesystem root that only
// exists inside the container image. Started any other way — a self-hoster on
// their own machine, which is the deployment shape this project targets — the
// first ensureDataDir() died with EACCES: mkdir '/workspace' and the service
// never came up. ~/nexus-workspace matches the convention Nexus-Computer
// already settled on for the same bug.
//
// DATA_DIR still wins, so container images can keep passing DATA_DIR=/workspace.
const root =
  process.env.DATA_DIR ?? path.join(os.homedir(), "nexus-workspace", "deploy");

const baseDomain = process.env.BASE_DOMAIN ?? "localhost";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
  baseDomain,
  // Where the dashboard, the API and the short links (<controlHost>/<slug>) live.
  controlHost: process.env.CONTROL_HOST ?? `deploy.${baseDomain}`,
  // Where one app is reachable. `{slug}` and `{BASE_DOMAIN}` are substituted.
  appHostPattern: process.env.APP_HOST_PATTERN ?? "{slug}.{BASE_DOMAIN}",
  // Loopback ports apps are published on. The ingress reaches an app only here.
  appPortRange: parsePortRange(process.env.APP_PORT_RANGE ?? "20000-29999"),
  // The rootless sandbox daemon, e.g. unix:///run/user/1001/docker.sock. Empty
  // means "not configured": every Docker call then refuses to run, so a
  // misconfigured node can never fall back to the host's own daemon.
  sandboxDockerHost: process.env.SANDBOX_DOCKER_HOST ?? "",
  // Mount point of the sandbox's size-capped storage. Builds are refused when it,
  // or the data directory's volume, is nearly full.
  sandboxStoragePath: process.env.SANDBOX_STORAGE_PATH ?? "",
  // Nexus Cloud's registry is how the ingress learns where a live app listens.
  // Empty CLOUD_URL means this node has no ingress to tell: nothing is announced.
  cloudUrl: process.env.CLOUD_URL ?? "",
  // Cloud's credential for apps members deploy. Not the node API key: that one is
  // shared by every ecosystem service and cannot publish an isolated route.
  cloudUserAppsKey: process.env.CLOUD_USER_APPS_KEY ?? "",
  cloudTimeoutMs: Number(process.env.CLOUD_TIMEOUT_MS ?? 5000),
  // How often live routes are re-announced, which is also Cloud's heartbeat.
  cloudHeartbeatMs: Number(process.env.CLOUD_HEARTBEAT_MS ?? 30_000),
  // Hosting's site-proxy, asked whether a name already belongs to a site so a new
  // app never shadows one. Empty means this node has no Hosting to ask.
  hostingSiteUrl: process.env.HOSTING_SITE_URL ?? "",
  // Safeguards (CAP_* variables). The same for every member of the node.
  limits: limitsFromEnv(process.env),
  dataDir: root,
  dbPath: path.join(root, "nexus-deploy.json"),
  appSecret: process.env.APP_SECRET ?? "change-me",
  jwtSecret: process.env.JWT_SECRET ?? "change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  adminEmail: process.env.ADMIN_EMAIL ?? "owner@the-no-hands.company",
  adminPassword: process.env.ADMIN_PASSWORD ?? "change-me",
  allowRegistration: (process.env.ALLOW_REGISTRATION ?? "false") === "true",
  // Identity is owned by Nexus-Auth for the whole ecosystem, not by this app.
  // See src/middleware/auth.ts.
  nexusAuthUrl: process.env.NEXUS_AUTH_URL ?? "http://localhost:4310",
  nexusAuthTimeoutMs: Number(process.env.NEXUS_AUTH_TIMEOUT_MS ?? 5000),
  // Where to send a *browser* to sign in. Distinct from nexusAuthUrl, which is
  // the internal address this server calls: that is typically localhost and is
  // useless to a user's browser.
  nexusAuthPublicUrl:
    process.env.NEXUS_AUTH_PUBLIC_URL ?? process.env.NEXUS_AUTH_URL ?? "http://localhost:4310",
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  // file: repositories clone off this machine's disk; off unless a test harness
  // asks for them. See src/lib/repo.ts.
  allowLocalRepos: (process.env.DEPLOY_ALLOW_LOCAL_REPOS ?? "false") === "true",
  // How long a new container gets to answer its health probe before the
  // release is rejected and the previous image is put back.
  healthTimeoutMs: Number(process.env.DEPLOY_HEALTH_TIMEOUT_MS ?? 60_000),
  healthIntervalMs: Number(process.env.DEPLOY_HEALTH_INTERVAL_MS ?? 1_000),
  nexusAiUrl: process.env.NEXUS_AI_URL ?? "",
  nexusAiApiKey: process.env.NEXUS_AI_API_KEY ?? "",
  nexusAiCompletionPath: process.env.NEXUS_AI_COMPLETION_PATH ?? "/v1/chat/completions",
};

export function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}
