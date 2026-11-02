import { describe, expect, it } from "vitest";
import { memberRowRules } from "./member-rules";

const rules = (actorRole: string, role: string, opts: { self?: boolean; owners?: number } = {}) =>
  memberRowRules({
    actorRole,
    actorId: "me",
    target: { userId: opts.self ? "me" : "them", role },
    ownerCount: opts.owners ?? 2,
  });

describe("memberRowRules", () => {
  it("members and viewers get no controls and a reason", () => {
    for (const role of ["member", "viewer"]) {
      const r = rules(role, "viewer");
      expect(r.assignableRoles).toEqual([]);
      expect(r.canRemove).toBe(false);
      expect(r.reason).toMatch(/owners and admins/);
    }
  });

  it("an owner can set any other role, including owner, and remove others", () => {
    const r = rules("owner", "member");
    expect(r.assignableRoles).toEqual(["owner", "admin", "viewer"]);
    expect(r.canRemove).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("an admin can never grant owner, and has no controls on an owner", () => {
    expect(rules("admin", "member").assignableRoles).toEqual(["admin", "viewer"]);
    const onOwner = rules("admin", "owner");
    expect(onOwner.assignableRoles).toEqual([]);
    expect(onOwner.canRemove).toBe(false);
    expect(onOwner.reason).toMatch(/Only an owner/);
  });

  it("the only owner cannot be demoted or removed", () => {
    const r = rules("owner", "owner", { self: true, owners: 1 });
    expect(r.assignableRoles).toEqual([]);
    expect(r.canRemove).toBe(false);
    expect(r.reason).toMatch(/at least one owner/);
  });

  it("with two owners one may step down, but nobody removes themselves", () => {
    const r = rules("owner", "owner", { self: true, owners: 2 });
    expect(r.assignableRoles).toEqual(["admin", "member", "viewer"]);
    expect(r.canRemove).toBe(false);
    expect(r.reason).toMatch(/cannot remove yourself/);
  });
});
