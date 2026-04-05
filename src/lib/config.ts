import fs from "node:fs";
import path from "node:path";

const root = process.env.DATA_DIR ?? "/workspace";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
  dataDir: root,
  dbPath: path.join(root, "nexus-deploy.json"),
  appSecret: process.env.APP_SECRET ?? "change-me",
  jwtSecret: process.env.JWT_SECRET ?? "change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  adminEmail: process.env.ADMIN_EMAIL ?? "owner@the-no-hands.company",
  adminPassword: process.env.ADMIN_PASSWORD ?? "change-me",
  allowRegistration: (process.env.ALLOW_REGISTRATION ?? "false") === "true",
};

export function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}
