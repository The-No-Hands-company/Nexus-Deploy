import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adoptOrphanProjects,
  bootstrapOwner,
  canAccessProject,
  grantMember,
  isOperator,
  resolveAccess,
  setMemberStatus,
} from "../src/lib/members.js";
import type { Member, Project } from "../src/types.js";

const member = (authUserId: string, patch: Partial<Member> = {}): Member => ({
  authUserId,
  role: "member",
  status: "active",
  grantedBy: "boss",
  grantedAt: 1,
  ...patch,
});

test("founders and admins are operators; nobody else is", () => {
  assert.equal(isOperator({ id: "a", role: "founder" }), true);
  assert.equal(isOperator({ id: "a", role: "admin" }), true);
  assert.equal(isOperator({ id: "a", role: "user" }), false);
  assert.equal(isOperator({ id: "a" }), false);
});

test("an account nobody let in is refused", () => {
  assert.deepEqual(resolveAccess([], { id: "u1", role: "user" }), {
    ok: false,
    reason: "not_a_member",
  });
});

test("a granted member is let in, without operator rights", () => {
  assert.deepEqual(resolveAccess([member("u1")], { id: "u1", role: "user" }), {
    ok: true,
    operator: false,
    memberId: "u1",
  });
});

test("operators are let in without being on the list", () => {
  assert.deepEqual(resolveAccess([], { id: "boss", role: "admin" }), {
    ok: true,
    operator: true,
    memberId: "boss",
  });
});

test("suspension shuts an account out, even an operator's", () => {
  const members = [member("u1", { status: "suspended" }), member("op", { status: "suspended" })];
  assert.deepEqual(resolveAccess(members, { id: "u1", role: "user" }), {
    ok: false,
    reason: "suspended",
  });
  assert.deepEqual(resolveAccess(members, { id: "op", role: "admin" }), {
    ok: false,
    reason: "suspended",
  });
});

test("the first founder becomes the owner, once", () => {
  const members: Member[] = [];
  const owner = bootstrapOwner(members, { id: "zajfan", role: "founder" }, 5);
  assert.equal(owner?.role, "owner");
  assert.equal(owner?.authUserId, "zajfan");
  assert.equal(members.length, 1);
  assert.equal(bootstrapOwner(members, { id: "someone", role: "founder" }, 6), null);
  assert.equal(members.length, 1);
});

test("an admin or an ordinary user cannot claim an empty node", () => {
  const members: Member[] = [];
  assert.equal(bootstrapOwner(members, { id: "a", role: "admin" }, 1), null);
  assert.equal(bootstrapOwner(members, { id: "u", role: "user" }, 1), null);
  assert.equal(members.length, 0);
});

test("a member sees their own projects, an operator sees all, nobody sees an unowned one by accident", () => {
  const mine = { ownerId: "u1" };
  const theirs = { ownerId: "u2" };
  const orphan = {};
  const asMember = { ok: true as const, operator: false, memberId: "u1" };
  const asOperator = { ok: true as const, operator: true, memberId: "boss" };
  assert.equal(canAccessProject(mine, asMember), true);
  assert.equal(canAccessProject(theirs, asMember), false);
  assert.equal(canAccessProject(orphan, asMember), false);
  assert.equal(canAccessProject(theirs, asOperator), true);
  assert.equal(canAccessProject(orphan, asOperator), true);
});

test("projects from before ownership are adopted by the owner, not by whoever asks", () => {
  const projects = [{ id: "a" }, { id: "b", ownerId: "u9" }] as Project[];
  assert.equal(adoptOrphanProjects(projects, "zajfan"), 1);
  assert.deepEqual(
    projects.map((p) => p.ownerId),
    ["zajfan", "u9"],
  );
});

test("granting twice does not duplicate, and re-activates a suspended member", () => {
  const members = [member("u1", { status: "suspended" })];
  const again = grantMember(
    members,
    { id: "boss", role: "admin" },
    { authUserId: "u1", label: "Ada" },
    9,
  );
  assert.equal(members.length, 1);
  assert.equal(again.status, "active");
  assert.equal(again.label, "Ada");
  const fresh = grantMember(members, { id: "boss", role: "admin" }, { authUserId: "u2" }, 9);
  assert.equal(members.length, 2);
  assert.equal(fresh.grantedBy, "boss");
  assert.equal(fresh.role, "member");
});

test("an owner cannot be suspended, so the node cannot lock out its own operators", () => {
  const members = [member("o", { role: "owner" }), member("u1")];
  assert.equal(setMemberStatus(members, "o", "suspended"), "is_owner");
  assert.equal(members[0]?.status, "active");
  assert.equal(setMemberStatus(members, "u1", "suspended"), "ok");
  assert.equal(members[1]?.status, "suspended");
  assert.equal(setMemberStatus(members, "missing", "active"), "not_found");
});
