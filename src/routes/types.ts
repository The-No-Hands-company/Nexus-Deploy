import type { RequestHandler } from "express";
import type { ContainerStats } from "../lib/docker.js";
import type { RoutePublisher } from "../lib/publisher.js";
import type { Limits, Verdict } from "../lib/safeguards.js";
import type { Authenticator } from "../middleware/auth.js";
import type { Deployment, DeployTrigger, Project } from "../types.js";

/** Starting, stopping and cancelling builds. Injected so the routes are tested without Docker or Git. */
export type Pipeline = {
  createDeployment(project: Project, commitSha: string, trigger: DeployTrigger): Deployment;
  runDeploy(project: Project, deploymentId: string): Promise<void>;
  runRollback(project: Project, deploymentId: string, imageRef: string): Promise<void>;
  isBuilding(projectId: string): boolean;
  cancelBuild(deploymentId: string): Promise<boolean>;
  guardBuild(project: Project): Verdict;
};

/** What the routes do to containers, images and volumes. All of it targets the sandbox daemon. */
export type ProjectOps = {
  stop(name: string): Promise<void>;
  start(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  status(name: string): Promise<string>;
  stats(name: string): Promise<ContainerStats | null>;
  logs(name: string, onLine: (line: string) => void, onEnd?: (err?: Error) => void): () => void;
  removeVolume(name: string): Promise<void>;
  removeImage(ref: string): Promise<boolean>;
};

export type AppDeps = {
  authenticate: Authenticator;
  pipeline: Pipeline;
  ops: ProjectOps;
  publisher: RoutePublisher;
  /** True if Cloud's registry or a Hosting site already uses the name. Throwing means "could not check". */
  takenElsewhere: (slug: string) => Promise<boolean>;
  limits: Limits;
  allowLocalRepos: boolean;
  now: () => number;
  node: { baseDomain: string; controlHost: string; hostPattern: string };
  version: string;
  /** Built dashboard to serve, or null for an API-only server (tests). */
  staticDir: string | null;
};

export type RouteContext = {
  deps: AppDeps;
  /** Signed in with Nexus-Auth. */
  auth: RequestHandler;
  /** Signed in, and an operator has let the account in (operators always are). */
  member: RequestHandler[];
  /** A member who is also an operator. */
  operator: RequestHandler[];
};
