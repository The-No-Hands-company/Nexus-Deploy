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
  getRoutePublisher,
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

export function realDeps(): AppDeps {
  return {
    authenticate: authenticateWithNexusAuth,
    pipeline: {
      createDeployment,
      runDeploy: (project, deploymentId) => runDeploy(project, deploymentId),
      runRollback: (project, deploymentId, imageRef) => runRollback(project, deploymentId, imageRef),
      isBuilding,
      cancelBuild,
      guardBuild: (project) => guardBuild(project),
    },
    ops: dockerOps,
    publisher: getRoutePublisher(),
    // Until the edge is wired in, only Deploy's own projects are checked for a taken name.
    takenElsewhere: async () => false,
    limits: config.limits,
    allowLocalRepos: config.allowLocalRepos,
    now: Date.now,
    node: { baseDomain: config.baseDomain, controlHost: config.controlHost, hostPattern: config.appHostPattern },
    version: packageVersion(),
    staticDir: "web/dist",
  };
}
