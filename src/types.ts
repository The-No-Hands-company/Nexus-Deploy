export type Role = "owner" | "admin" | "member";

export type User = {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: number;
};

export type ProjectStatus = "idle" | "building" | "live" | "failed" | "stopped";

export type Project = {
  id: string;
  name: string;
  repo: string;
  branch: string;
  buildContext: string;
  dockerfile?: string;      // relative to the repo root; default <buildContext>/Dockerfile
  healthPath?: string;      // must answer 2xx before a release is live; default: any non-5xx on "/"
  buildCommand: string;
  startCommand: string;
  volumePath: string;
  port: number;
  env: Record<string, string>;
  status: ProjectStatus;
  domain?: string;
  customDomain?: string;
  containerId?: string;
  imageTag?: string;
  webhookSecret?: string;
  memoryLimit?: string;
  cpus?: string;
  notifyUrl?: string;       // POST here on deploy success/failure
  autoDeployEnabled: boolean; // whether webhook pushes trigger builds
  createdAt: number;
  updatedAt: number;
};

export type DeployTrigger = "manual" | "webhook" | "rollback";
export type DeploymentStatus = "queued" | "building" | "live" | "failed" | "cancelled";

export type Deployment = {
  id: string;
  projectId: string;
  commitSha: string;
  triggeredBy: DeployTrigger;
  status: DeploymentStatus;
  imageTag: string;
  logs: string[];
  createdAt: number;
  finishedAt?: number;
};

export type Session = {
  token: string;
  userId: string;
  createdAt: number;
};

export type SSEEvent =
  | { type: "status"; projectId: string; status: ProjectStatus }
  | { type: "ping" };
