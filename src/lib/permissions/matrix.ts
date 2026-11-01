/**
 * The permission matrix (PRD 5.1) as data. Everything else in this folder, and every UI control
 * that is shown or hidden, is derived from this one table. The database (RLS) is the final
 * authority; this module is the single server-side source for role checks before a request
 * reaches it, and it must agree with the policies. Hiding a control is cosmetic only.
 *
 * Adding an action without a rule for it, or a rule without a cell for every role, fails
 * typecheck (`satisfies Record<Action, ...>` below).
 */

export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** `demo` workspaces belong to an anonymous guest, who is their (limited) owner. */
export const WORKSPACE_KINDS = ["real", "demo"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export const ACTIONS = [
  /** Read customers, opportunities, tasks, quotes, activity, dashboard, and reports. */
  "records.read",
  /** Create, edit, and archive customers, opportunities, and tasks. */
  "records.write",
  /** Create and modify quotes (P1). */
  "quotes.write",
  /** Export CSV or PDF. */
  "export.run",
  /** Change organization name and settings. */
  "org.settings.update",
  /** Invite and remove members, and change non-owner roles. */
  "members.manage",
  /** Promote someone to owner, or demote or remove an owner (subject to the last-owner guard). */
  "members.owner_change",
  /** Configure external service connections (P2). */
  "integrations.manage",
  /** Billing and subscriptions (P2). */
  "billing.manage",
  /** Send real email or other outbound messages (P2). */
  "email.send_external",
  /** Reset the caller's own demo workspace. */
  "demo.reset",
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * A condition that comes with an allow. The matrix says "Yes, quota-limited" for guests; the
 * check passes, and the caller must still honor the constraint (the database enforces it).
 */
export type Constraint =
  /** Reads are limited to the caller's own demo workspace. */
  | "own_demo_org_only"
  /** Hard row caps apply (SIT-200). */
  | "demo_quota_limited"
  /** Quote "send" only changes status; nothing is emailed. */
  | "demo_simulated_only"
  /** Exports are marked as sample / fictional data. */
  | "demo_fictional_marking"
  /** An owner may not demote or remove the last owner (enforced in SQL, SIT-202). */
  | "last_owner_guard"
  /** An admin may not touch owners or grant the owner role. */
  | "no_owner_changes";

type Cell = { allow: false } | { allow: true; constraints?: readonly Constraint[] };

type RoleCells = Record<Role, Cell>;

type ActionRule = {
  /** What each role may do in a REAL workspace. */
  roles: RoleCells;
  /** What the demo guest may do, as an additional restriction on top of the role. */
  demo: Cell;
  /** The action only exists in one kind of workspace. */
  onlyIn?: WorkspaceKind;
};

const YES: Cell = { allow: true };
const NO: Cell = { allow: false };
const yes = (...constraints: Constraint[]): Cell => ({ allow: true, constraints });

const writers: RoleCells = { owner: YES, admin: YES, member: YES, viewer: NO };

export const MATRIX = {
  "records.read": {
    roles: { owner: YES, admin: YES, member: YES, viewer: YES },
    demo: yes("own_demo_org_only"),
  },
  "records.write": { roles: writers, demo: yes("demo_quota_limited") },
  "quotes.write": { roles: writers, demo: yes("demo_simulated_only") },
  "export.run": {
    roles: { owner: YES, admin: YES, member: YES, viewer: YES },
    demo: yes("demo_fictional_marking"),
  },
  "org.settings.update": { roles: { owner: YES, admin: YES, member: NO, viewer: NO }, demo: NO },
  "members.manage": {
    roles: { owner: YES, admin: yes("no_owner_changes"), member: NO, viewer: NO },
    demo: NO,
  },
  "members.owner_change": {
    roles: { owner: yes("last_owner_guard"), admin: NO, member: NO, viewer: NO },
    demo: NO,
  },
  "integrations.manage": { roles: { owner: YES, admin: NO, member: NO, viewer: NO }, demo: NO },
  "billing.manage": { roles: { owner: YES, admin: NO, member: NO, viewer: NO }, demo: NO },
  // Not in the PRD matrix. Interpretation: whoever can write records may trigger a notification;
  // viewers and demo guests never can (PRD 8.2: no real emails from the demo).
  "email.send_external": { roles: writers, demo: NO },
  "demo.reset": {
    roles: { owner: YES, admin: NO, member: NO, viewer: NO },
    demo: YES,
    onlyIn: "demo",
  },
} as const satisfies Record<Action, ActionRule>;

export type { ActionRule, Cell, RoleCells };
