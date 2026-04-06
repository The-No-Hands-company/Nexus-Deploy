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
  buildCommand: string;
  startCommand: string;
  volumePath: string;
  port: number;
  env: Record<string, string>;
  status: ProjectStatus;
  domain?: string;          // auto-assigned: name.baseDomain
  customDomain?: string;    // user-supplied custom domain
  containerId?: string;
  imageTag?: string;
  webhookSecret?: string;
  createdAt: number;
  updatedAt: number;
};

export type DeployTrigger = "manual" | "webhook" | "rollback";
export type DeploymentStatus = "queued" | "building" | "live" | "failed";

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

// SSE event shape sent to dashboard
export type SSEEvent =
  | { type: "status"; projectId: string; status: ProjectStatus }
  | { type: "ping" };
