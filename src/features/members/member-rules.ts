/**
 * What the Members page offers for each row. This is only presentation: it hides or disables controls and explains why.
 * The API and the database enforce every one of these rules again (SIT-202, SIT-224), so a stale or forged page gets a
 * refusal, never a change.
 */
export type Role = "owner" | "admin" | "member" | "viewer";

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

export const ROLE_HELP: Record<Role, string> = {
  owner: "Full control, including billing and other owners.",
  admin: "Manages members and settings, but cannot change owners.",
  member: "Creates and edits records.",
  viewer: "Reads everything, changes nothing.",
};

export type MemberRowRules = {
  /** Roles the actor may set on this person (empty when none). */
  assignableRoles: Role[];
  canRemove: boolean;
  /** Why the controls are missing or disabled, in words; null when nothing is restricted. */
  reason: string | null;
};

type Input = {
  actorRole: string;
  actorId: string;
  target: { userId: string; role: string };
  ownerCount: number;
};

const ALL: Role[] = ["owner", "admin", "member", "viewer"];

export function memberRowRules({ actorRole, actorId, target, ownerCount }: Input): MemberRowRules {
  const none = (reason: string | null): MemberRowRules => ({
    assignableRoles: [],
    canRemove: false,
    reason,
  });
  if (actorRole !== "owner" && actorRole !== "admin") {
    return none("Only owners and admins can manage members.");
  }
  const isSelf = target.userId === actorId;
  if (actorRole === "admin" && target.role === "owner") {
    return none("Only an owner can change or remove an owner.");
  }
  const soleOwner = target.role === "owner" && ownerCount <= 1;
  const roles = ALL.filter((r) => r !== target.role && !(actorRole === "admin" && r === "owner"));
  if (soleOwner) {
    return none("A workspace needs at least one owner. Make someone else an owner first.");
  }
  return {
    assignableRoles: roles,
    canRemove: !isSelf,
    reason: isSelf ? "You cannot remove yourself. Ask another owner to do it." : null,
  };
}
