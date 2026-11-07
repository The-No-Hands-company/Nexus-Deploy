export interface User {
  id: string;
  username?: string;
  email?: string;
  role?: string;
}

export type MemberAccess =
  | { member: true; operator: boolean }
  | { member: false; reason: "not_a_member" | "suspended" };

export interface NodeInfo {
  baseDomain: string;
  controlHost: string;
  hostPattern: string;
}

export interface NodeLimits {
  maxProjectsPerMember: number;
  maxConcurrentBuildsPerMember: number;
  buildsPerHour: number;
  minDeployIntervalMs: number;
  buildTimeoutMs: number;
  pullTimeoutMs: number;
  memory: string;
  cpus: string;
  pidsLimit: number;
  minDiskFreeRatio: number;
}

export interface LimitsResponse {
  limits: NodeLimits;
  baseDomain: string;
  controlHost: string;
  appHostPattern: string;
  availability: string;
}

export type PublicProjectSource =
  | { type: "git"; repo: string; branch: string; hasToken: boolean }
  | { type: "image"; image: string };

export interface Project {
  id: string;
  ownerId?: string;
  name: string;
  repo: string;
  branch: string;
  source?: PublicProjectSource;
  buildContext?: string;
  dockerfile?: string;
  healthPath?: string;
  buildCommand: string;
  startCommand: string;
  volumePath: string;
  port: number;
  env: Record<string, string>;
  status: "idle" | "building" | "live" | "failed" | "stopped";
  containerId?: string;
  containerName?: string;
  hostPort?: number;
  imageTag?: string;
  webhookSecret: string;
  autoDeployEnabled: boolean;
  notifyUrl?: string;
  memoryLimit?: string;
  cpus?: string;
  latestDeployment?: Deployment | null;
  createdAt: number;
  updatedAt: number;
}

export interface Deployment {
  id: string;
  projectId: string;
  commitSha: string;
  triggeredBy: "manual" | "webhook" | "rollback";
  status: "queued" | "building" | "live" | "failed" | "cancelled";
  logs: string[];
  imageTag?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface ActivityItem {
  id: string;
  projectId: string;
  projectName: string;
  commitSha: string;
  triggeredBy: string;
  status: string;
  createdAt: number;
  finishedAt?: number;
}

export interface MemberRecord {
  authUserId: string;
  role: "owner" | "member";
  status: "active" | "suspended";
  grantedBy: string;
  grantedAt: number;
  label?: string;
}

export interface AuditEntry {
  at: number;
  actor: string;
  action: string;
  subject: string;
}

export type SessionResult =
  | {
      kind: "signed-in";
      user: User;
      access: { member: true; operator: boolean };
      node: NodeInfo;
      wsToken: string;
    }
  | { kind: "not-a-member"; user: User; reason: "not_a_member" | "suspended"; node: NodeInfo }
  | { kind: "signed-out" }
  | { kind: "unreachable" };
