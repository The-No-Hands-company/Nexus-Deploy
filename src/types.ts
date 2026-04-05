export type Role = "owner" | "admin" | "member";

export type User = {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: number;
};

export type Project = {
  id: string;
  name: string;
  repo: string;
  branch: string;
  buildCommand: string;
  startCommand: string;
  volumePath: string;
  env: Record<string, string>;
  createdAt: number;
  updatedAt: number;
};

export type DeploymentStatus = "queued" | "building" | "live" | "failed";

export type Deployment = {
  id: string;
  projectId: string;
  commitSha: string;
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
