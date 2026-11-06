/**
 * The real dependencies: Nexus-Auth for identity, the sandbox daemon for
 * containers, the build pipeline for deployments. Tests build an AppDeps of
 * their own instead of calling this.
 */
import fs from "node:fs";
import { authenticateWithNexusAuth } from "../middleware/auth.js";
import type { AppDeps, ProjectOps } from "../routes/types.js";
import {
  cancelBuild,
  createDeployment,
  guardBuild,
  isBuilding,
  runDeploy,
  runRollback,
} from "./build.js";
import { config } from "./config.js";
import {
  dockerLogs,
  dockerRemove,
  dockerRemoveImage,
  dockerRemoveVolume,
  dockerRestart,
  dockerStart,
  dockerStats,
  dockerStatus,
  dockerStop,
} from "./docker.js";
import { type Edge, createEdge } from "./edge.js";
import { loadDb } from "./store.js";

export const dockerOps: ProjectOps = {
  stop: dockerStop,
  start: dockerStart,
  restart: dockerRestart,
  remove: dockerRemove,
  status: dockerStatus,
  stats: dockerStats,
  logs: dockerLogs,
  removeVolume: dockerRemoveVolume,
  removeImage: dockerRemoveImage,
};

export function packageVersion(): string {
  try {
    const raw = fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** The ingress this node is configured with. */
export function realEdge(): Edge {
  return createEdge(config, () => loadDb().projects);
}

export function realDeps(edge: Edge): AppDeps {
  return {
    authenticate: authenticateWithNexusAuth,
    pipeline: {
      createDeployment,
      runDeploy: (project, deploymentId) => runDeploy(project, deploymentId),
      runRollback: (project, deploymentId, imageRef) =>
        runRollback(project, deploymentId, imageRef),
      isBuilding,
      cancelBuild,
      guardBuild: (project) => guardBuild(project),
    },
    ops: dockerOps,
    publisher: edge.publisher,
    takenElsewhere: edge.takenElsewhere,
    limits: config.limits,
    allowLocalRepos: config.allowLocalRepos,
    now: Date.now,
    node: {
      baseDomain: config.baseDomain,
      controlHost: config.controlHost,
      hostPattern: config.appHostPattern,
    },
    version: packageVersion(),
    staticDir: "web/dist",
  };
}
