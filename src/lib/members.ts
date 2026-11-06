/**
 * Who may use this node's Deploy, and which projects they may touch.
 *
 * Identity belongs to Nexus-Auth. Here an operator (an Auth founder or admin)
 * lets individual accounts in; there is no separate signup. Operators can always
 * use Deploy and see every project. Everyone else sees only their own.
 */
import type { Member, MemberStatus, Project } from "../types.js";

export type Identity = {
  id: string;
  role?: string | undefined;
  username?: string | undefined;
  email?: string | undefined;
};

export function isOperator(identity: Identity): boolean {
  return identity.role === "founder" || identity.role === "admin";
}

export type GrantedAccess = { ok: true; operator: boolean; memberId: string };
export type Access = GrantedAccess | { ok: false; reason: "not_a_member" | "suspended" };

export function resolveAccess(members: readonly Member[], identity: Identity): Access {
  const member = members.find((m) => m.authUserId === identity.id);
  // Suspension wins over everything, including operator status: it is how an
  // operator shuts one account out, and the check must not have a back door.
  if (member?.status === "suspended") return { ok: false, reason: "suspended" };
  if (isOperator(identity)) return { ok: true, operator: true, memberId: identity.id };
  if (member?.status === "active") return { ok: true, operator: false, memberId: identity.id };
  return { ok: false, reason: "not_a_member" };
}

/**
 * Make the first founder to arrive the owner. Only when nobody is a member yet,
 * and only for a founder, so a fresh node cannot be claimed by a lesser role.
 */
export function bootstrapOwner(members: Member[], identity: Identity, now: number): Member | null {
  if (members.length > 0 || identity.role !== "founder") return null;
  const owner: Member = {
    authUserId: identity.id,
    role: "owner",
    status: "active",
    grantedBy: identity.id,
    grantedAt: now,
  };
  members.push(owner);
  return owner;
}

export function canAccessProject(
  project: Pick<Project, "ownerId">,
  access: GrantedAccess,
): boolean {
  return access.operator || (project.ownerId !== undefined && project.ownerId === access.memberId);
}

/** Give projects from before ownership existed to `ownerId`. Returns how many moved. */
export function adoptOrphanProjects(projects: Project[], ownerId: string): number {
  let adopted = 0;
  for (const project of projects) {
    if (project.ownerId === undefined) {
      project.ownerId = ownerId;
      adopted++;
    }
  }
  return adopted;
}

/** Granting again re-activates a suspended member rather than duplicating them. */
export function grantMember(
  members: Member[],
  actor: Identity,
  target: { authUserId: string; label?: string },
  now: number,
): Member {
  const existing = members.find((m) => m.authUserId === target.authUserId);
  if (existing) {
    existing.status = "active";
    if (target.label !== undefined) existing.label = target.label;
    return existing;
  }
  const member: Member = {
    authUserId: target.authUserId,
    role: "member",
    status: "active",
    grantedBy: actor.id,
    grantedAt: now,
    ...(target.label !== undefined ? { label: target.label } : {}),
  };
  members.push(member);
  return member;
}

export function setMemberStatus(
  members: Member[],
  authUserId: string,
  status: MemberStatus,
): "ok" | "not_found" | "is_owner" {
  const member = members.find((m) => m.authUserId === authUserId);
  if (!member) return "not_found";
  // An owner cannot be suspended, or the node could lock out everyone who can fix it.
  if (member.role === "owner" && status === "suspended") return "is_owner";
  member.status = status;
  return "ok";
}
