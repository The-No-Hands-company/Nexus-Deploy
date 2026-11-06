export type Role = "owner" | "admin" | "member";

export type User = {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: number;
};

export type MemberRole = "owner" | "member";
export type MemberStatus = "active" | "suspended";

/** Someone an operator has let use this node's Deploy. Identity itself lives in Nexus-Auth. */
export type Member = {
  authUserId: string;
  role: MemberRole;
  status: MemberStatus;
  grantedBy: string;
  grantedAt: number;
  label?: string;
};

/** Exactly one source per project. A Git source is cloned and built; an image source is pulled. */
export type GitSource = { type: "git"; repo: string; branch: string; token?: string };
export type ImageSource = { type: "image"; image: string };
export type Source = GitSource | ImageSource;

export type ProjectStatus = "idle" | "building" | "live" | "failed" | "stopped";

export type Project = {
  id: string;
  /** Nexus-Auth id of the member who owns it. Absent only on projects from before ownership existed. */
  ownerId?: string;
  name: string;
  /** Display copy of the source: the repo URL, or the image reference for an image project. */
  repo: string;
  /** Branch for a Git source; empty for an image project. */
  branch: string;
  /** Authoritative source. Absent on projects from before sources existed: see sourceOf(). */
  source?: Source;
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
