import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

export const config = {
  port: Number(process.env.PORT ?? 3000),
  baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
  baseDomain: process.env.BASE_DOMAIN ?? "localhost",
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
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  dockerNetwork: process.env.DOCKER_NETWORK ?? "nexus-net",
  nexusAiUrl: process.env.NEXUS_AI_URL ?? "",
  nexusAiApiKey: process.env.NEXUS_AI_API_KEY ?? "",
  nexusAiCompletionPath: process.env.NEXUS_AI_COMPLETION_PATH ?? "/v1/chat/completions",
};

export function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}
