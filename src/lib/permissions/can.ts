import { ForbiddenError } from "@/lib/api/errors";
import {
  ACTIONS,
  MATRIX,
  ROLES,
  WORKSPACE_KINDS,
  type Action,
  type ActionRule,
  type Cell,
  type Constraint,
  type Role,
  type WorkspaceKind,
} from "./matrix";

/** Why a check said no. Stable codes: UI and API branch on them. */
export type DenyReason =
  | "ROLE_INSUFFICIENT"
  | "DEMO_RESTRICTED"
  | "NOT_APPLICABLE"
  | "UNKNOWN_ACTION"
  | "UNKNOWN_ROLE"
  | "UNKNOWN_KIND";

export type Decision =
  { allowed: true; constraints: readonly Constraint[] } | { allowed: false; reason: DenyReason };

const DENY = (reason: DenyReason): Decision => ({ allowed: false, reason });

const has = (table: object, key: string): boolean => Object.hasOwn(table, key);

/** Narrowing guards for values that arrive as plain strings (database rows, JWT claims). */
export const isRole = (value: unknown): value is Role =>
  typeof value === "string" && (ROLES as readonly string[]).includes(value);
export const isWorkspaceKind = (value: unknown): value is WorkspaceKind =>
  typeof value === "string" && (WORKSPACE_KINDS as readonly string[]).includes(value);
export const isAction = (value: unknown): value is Action =>
  typeof value === "string" && (ACTIONS as readonly string[]).includes(value);

function merge(role: Cell, demo: Cell | null): Decision {
  if (!role.allow) return DENY("ROLE_INSUFFICIENT");
  if (demo === null) return { allowed: true, constraints: role.constraints ?? [] };
  if (!demo.allow) return DENY("DEMO_RESTRICTED");
  return { allowed: true, constraints: [...(role.constraints ?? []), ...(demo.constraints ?? [])] };
}

/**
 * May `role` do `action` in a `kind` workspace? Anything not in the matrix denies: an unknown
 * role, kind, or action (including names like `toString`) is never allowed.
 *
 * In a demo workspace the guest is the owner, and the demo column of the matrix applies on top
 * of the role. The returned `constraints` must still be honored by the caller (quota caps,
 * simulated quotes, fictional-data marking, the last-owner guard).
 */
export function can(role: string, kind: string, action: string): Decision {
  if (!has(MATRIX, action)) return DENY("UNKNOWN_ACTION");
  if (!isRole(role)) return DENY("UNKNOWN_ROLE");
  if (!isWorkspaceKind(kind)) return DENY("UNKNOWN_KIND");

  const rule: ActionRule = MATRIX[action as Action];
  if (rule.onlyIn !== undefined && rule.onlyIn !== kind) return DENY("NOT_APPLICABLE");
  return merge(rule.roles[role], kind === "demo" ? rule.demo : null);
}

/** Every action the role may take in this kind of workspace. UI uses this to show controls. */
export function allowedActions(role: string, kind: string): Action[] {
  return ACTIONS.filter((action) => can(role, kind, action).allowed);
}

/** `{ action: boolean }` for the whole matrix, derived from the same table as `can`. */
export function permissionsFor(role: string, kind: string): Record<Action, boolean> {
  return Object.fromEntries(
    ACTIONS.map((action) => [action, can(role, kind, action).allowed]),
  ) as Record<Action, boolean>;
}

const MESSAGES: Record<DenyReason, string> = {
  ROLE_INSUFFICIENT: "Your role does not allow that.",
  DEMO_RESTRICTED: "That is not available in the demo workspace.",
  NOT_APPLICABLE: "That does not apply to this workspace.",
  UNKNOWN_ACTION: "You do not have permission to do that.",
  UNKNOWN_ROLE: "You do not have permission to do that.",
  UNKNOWN_KIND: "You do not have permission to do that.",
};

/**
 * For route handlers: returns the allow decision, or throws a 403 `ForbiddenError`. A demo
 * restriction carries the machine code `DEMO_RESTRICTED` so the UI can explain it. This is a
 * check before the database; RLS still re-checks every write.
 */
export function assertCan(
  role: string,
  kind: string,
  action: string,
): Extract<Decision, { allowed: true }> {
  const decision = can(role, kind, action);
  if (decision.allowed) return decision;
  throw new ForbiddenError(
    MESSAGES[decision.reason],
    decision.reason === "DEMO_RESTRICTED" ? "DEMO_RESTRICTED" : "FORBIDDEN",
  );
}

/**
 * Which roles may `actor` hand out (invitations and role changes)? Owners may grant admin,
 * member, and viewer, and promote to owner (`members.owner_change`, owner only). Admins may
 * invite and set members and viewers only: never admins or owners. Everyone else may grant
 * nothing. Derived from the matrix, not hard-coded per role.
 */
export function grantableRoles(actorRole: string, kind: string): Role[] {
  if (!can(actorRole, kind, "members.manage").allowed) return [];
  const mayPromoteToOwner = can(actorRole, kind, "members.owner_change").allowed;
  const onlyBelowAdmin = !mayPromoteToOwner; // an admin cannot create peers or owners
  return ROLES.filter((role) => {
    if (role === "owner") return mayPromoteToOwner;
    if (role === "admin") return !onlyBelowAdmin;
    return true;
  });
}

/**
 * May `actor` change `target` from `from` to `to` (`to` = null means remove)? Requires
 * `members.manage`; touching an owner, or granting owner, additionally requires
 * `members.owner_change`; and the new role must be one the actor may grant.
 */
export function canChangeMembership(input: {
  actorRole: string;
  kind: string;
  from: string;
  to: string | null;
}): Decision {
  const { actorRole, kind, from, to } = input;
  const manage = can(actorRole, kind, "members.manage");
  if (!manage.allowed) return manage;
  if (!isRole(from) || (to !== null && !isRole(to))) return DENY("UNKNOWN_ROLE");
  const touchesOwner = from === "owner" || to === "owner";
  if (touchesOwner) return can(actorRole, kind, "members.owner_change");
  if (to !== null && !grantableRoles(actorRole, kind).includes(to))
    return DENY("ROLE_INSUFFICIENT");
  return manage;
}
