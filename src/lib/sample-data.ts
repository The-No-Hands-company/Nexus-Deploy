import { newId } from "./auth.js";
import type { Database } from "./store.js";

export function seedDemoProjects(db: Database) {
  if (db.projects.length) return;
  db.projects.push({
    id: newId("prj"),
    name: "nexus-computer",
    repo: "The-No-Hands-company/nexus-computer",
    branch: "main",
    buildCommand: "npm run build",
    startCommand: "npm start",
    volumePath: "/workspace",
    env: { ANTHROPIC_API_KEY: "" },
    status: "idle",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}
