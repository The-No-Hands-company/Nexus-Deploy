import { newId } from "./auth.js";
import type { Database } from "./store.js";
import type { Deployment, Project } from "../types.js";

export function createDeployment(db: Database, project: Project, commitSha: string) {
  const deployment: Deployment = {
    id: newId("dep"),
    projectId: project.id,
    commitSha,
    status: "queued",
    imageTag: `nexus-deploy/${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${commitSha.slice(0, 8)}`,
    logs: [
      `[deploy] queued ${project.name}`,
      `[deploy] repo=${project.repo}`,
      `[deploy] branch=${project.branch}`,
      `[deploy] mount=${project.volumePath}`,
    ],
    createdAt: Date.now(),
  };
  db.deployments.unshift(deployment);
  return deployment;
}

export function appendLog(db: Database, deploymentId: string, line: string) {
  const deployment = db.deployments.find(item => item.id === deploymentId);
  if (!deployment) return;
  deployment.logs.push(line);
}

export function finishDeployment(db: Database, deploymentId: string, status: Deployment["status"]) {
  const deployment = db.deployments.find(item => item.id === deploymentId);
  if (!deployment) return;
  deployment.status = status;
  deployment.finishedAt = Date.now();
}
