import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/api/errors";
import { readFileSync } from "node:fs";
import {
  ACTIONS,
  allowedActions,
  assertCan,
  can,
  canChangeMembership,
  grantableRoles,
  permissionsFor,
  type Constraint,
  type Role,
} from ".";
import { renderMatrixMarkdown } from "./docs";

/**
 * PRD 5.1, transcribed independently of the implementation. A cell is "Y", "N", or "Y:" followed
 * by the qualifiers the PRD attaches ("quota-limited", "simulated-only", ...). Columns:
 * owner, admin, member, viewer, demo guest.
 */
type Cell = "Y" | "N" | `Y:${Constraint}`;
type Row = { name: string; actions: string[]; cells: [Cell, Cell, Cell, Cell, Cell] };

const PRD: Row[] = [
  {
    name: "Read business records/reports",
    actions: ["records.read"],
    cells: ["Y", "Y", "Y", "Y", "Y:own_demo_org_only"],
  },
  {
    name: "Create/edit/archive customer/opportunity/task",
    actions: ["records.write"],
    cells: ["Y", "Y", "Y", "N", "Y:demo_quota_limited"],
  },
  {
    name: "Create/modify quotes",
    actions: ["quotes.write"],
    cells: ["Y", "Y", "Y", "N", "Y:demo_simulated_only"],
  },
  {
    name: "Export CSV/PDF",
    actions: ["export.run"],
    cells: ["Y", "Y", "Y", "Y", "Y:demo_fictional_marking"],
  },
  {
    name: "Change org name/settings",
    actions: ["org.settings.update"],
    cells: ["Y", "Y", "N", "N", "N"],
  },
  {
    name: "Invite/remove members",
    actions: ["members.manage"],
    cells: ["Y", "Y:no_owner_changes", "N", "N", "N"],
  },
  {
    name: "Promote to owner/remove last owner",
    actions: ["members.owner_change"],
    cells: ["Y:last_owner_guard", "N", "N", "N", "N"],
  },
  {
    name: "Configure external services/billing",
    actions: ["integrations.manage", "billing.manage"],
    cells: ["Y", "N", "N", "N", "N"],
  },
];

const COLUMNS = ["owner", "admin", "member", "viewer", "demo guest"] as const;

/** Resolve a PRD column to a call of `can`. The demo guest is the owner of a demo workspace. */
function ask(column: (typeof COLUMNS)[number], action: string) {
  return column === "demo guest" ? can("owner", "demo", action) : can(column, "real", action);
}

const cases = PRD.flatMap((row) =>
  row.actions.flatMap((action) =>
    COLUMNS.map((column, i) => ({
      label: `${row.name} | ${action} | ${column}`,
      action,
      column,
      expected: row.cells[i],
    })),
  ),
);

describe("PRD 5.1: every cell of the matrix", () => {
  it("covers 8 PRD rows and 5 columns (9 actions x 5 columns)", () => {
    expect(PRD).toHaveLength(8);
    expect(cases).toHaveLength(9 * 5);
  });

  it.each(cases)("$label", ({ action, column, expected }) => {
    const decision = ask(column, action);
    if (expected === "N") {
      expect(decision.allowed).toBe(false);
      return;
    }
    expect(decision.allowed).toBe(true);
    const wanted = expected === "Y" ? [] : [expected.slice(2) as Constraint];
    if (decision.allowed) expect([...decision.constraints].sort()).toEqual(wanted.sort());
  });
});

describe("PRD 5.1: reset own demo org (N/A for real workspaces, yes for the guest)", () => {
  it("the demo guest can reset", () => {
    expect(can("owner", "demo", "demo.reset")).toEqual({ allowed: true, constraints: [] });
  });
  it.each(["owner", "admin", "member", "viewer"])(
    "%s in a real workspace: not applicable",
    (role) => {
      expect(can(role, "real", "demo.reset")).toEqual({ allowed: false, reason: "NOT_APPLICABLE" });
    },
  );
  it.each(["admin", "member", "viewer"])("a %s in a demo workspace cannot reset", (role) => {
    expect(can(role, "demo", "demo.reset").allowed).toBe(false);
  });
});

describe("demo guest restrictions (acceptance)", () => {
  const guest = (action: string) => can("owner", "demo", action);

  it.each([
    "members.manage",
    "members.owner_change",
    "billing.manage",
    "integrations.manage",
    "email.send_external",
    "org.settings.update",
  ])("is denied %s with DEMO_RESTRICTED", (action) => {
    expect(guest(action)).toEqual({ allowed: false, reason: "DEMO_RESTRICTED" });
  });

  it("is allowed business records, quotes, exports, and reset, each with its constraint", () => {
    expect(guest("records.write")).toMatchObject({
      allowed: true,
      constraints: ["demo_quota_limited"],
    });
    expect(guest("quotes.write")).toMatchObject({
      allowed: true,
      constraints: ["demo_simulated_only"],
    });
    expect(guest("export.run")).toMatchObject({
      allowed: true,
      constraints: ["demo_fictional_marking"],
    });
    expect(guest("demo.reset").allowed).toBe(true);
  });

  it("a demo workspace never grants more than the role would: a viewer in a demo cannot write", () => {
    expect(can("viewer", "demo", "records.write")).toEqual({
      allowed: false,
      reason: "ROLE_INSUFFICIENT",
    });
  });

  it("the same owner role in a real workspace is allowed those actions", () => {
    for (const action of [
      "members.manage",
      "billing.manage",
      "integrations.manage",
      "email.send_external",
    ]) {
      expect(can("owner", "real", action).allowed).toBe(true);
    }
  });
});

describe("email.send_external (not in the PRD matrix; documented interpretation)", () => {
  it.each([
    ["owner", true],
    ["admin", true],
    ["member", true],
    ["viewer", false],
  ])("%s in a real workspace: %s", (role, allowed) => {
    expect(can(role, "real", "email.send_external").allowed).toBe(allowed);
  });
});

describe("deny by default", () => {
  it.each([
    "",
    "records.delete",
    "RECORDS.READ",
    "records.read ",
    "toString",
    "__proto__",
    "constructor",
    "hasOwnProperty",
  ])("an unknown action %j is denied", (action) => {
    expect(can("owner", "real", action)).toEqual({ allowed: false, reason: "UNKNOWN_ACTION" });
  });

  it.each(["", "superadmin", "OWNER", "guest", "anon", "toString", "__proto__"])(
    "an unknown role %j is denied",
    (role) => {
      expect(can(role, "real", "records.read")).toEqual({ allowed: false, reason: "UNKNOWN_ROLE" });
    },
  );

  it.each(["", "REAL", "prod", "guest", "toString"])(
    "an unknown workspace kind %j is denied",
    (kind) => {
      expect(can("owner", kind, "records.read")).toEqual({
        allowed: false,
        reason: "UNKNOWN_KIND",
      });
    },
  );

  it("denies non-string inputs from untyped sources instead of throwing", () => {
    for (const bad of [undefined, null, 0, {}, []]) {
      expect(can(bad as unknown as string, "real", "records.read").allowed).toBe(false);
      expect(can("owner", bad as unknown as string, "records.read").allowed).toBe(false);
      expect(can("owner", "real", bad as unknown as string).allowed).toBe(false);
    }
  });
});

describe("UI helpers are derived from the same table", () => {
  it("allowedActions agrees with can for every role and kind", () => {
    for (const kind of ["real", "demo"]) {
      for (const role of ["owner", "admin", "member", "viewer"]) {
        const allowed = allowedActions(role, kind);
        for (const action of ACTIONS)
          expect(allowed.includes(action), `${role}/${kind}/${action}`).toBe(
            can(role, kind, action).allowed,
          );
      }
    }
  });

  it("permissionsFor returns a boolean for every action", () => {
    const perms = permissionsFor("viewer", "real");
    expect(Object.keys(perms).sort()).toEqual([...ACTIONS].sort());
    expect(perms["records.read"]).toBe(true);
    expect(perms["records.write"]).toBe(false);
    expect(permissionsFor("nonsense", "real")["records.read"]).toBe(false);
  });

  it("a viewer sees nothing but read and export; the demo guest sees no admin controls", () => {
    expect(allowedActions("viewer", "real")).toEqual(["records.read", "export.run"]);
    expect(allowedActions("owner", "demo")).toEqual([
      "records.read",
      "records.write",
      "quotes.write",
      "export.run",
      "demo.reset",
    ]);
  });
});

describe("assertCan", () => {
  it("returns the decision when allowed", () => {
    expect(assertCan("member", "real", "records.write")).toEqual({
      allowed: true,
      constraints: [],
    });
  });

  it("throws a 403 ForbiddenError when the role is not enough", () => {
    expect.assertions(4);
    try {
      assertCan("viewer", "real", "records.write");
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).status).toBe(403);
      expect((error as ForbiddenError).code).toBe("FORBIDDEN");
      expect((error as ForbiddenError).message).toBe("Your role does not allow that.");
    }
  });

  it("uses the machine code DEMO_RESTRICTED and a helpful message for a guest", () => {
    expect.assertions(2);
    try {
      assertCan("owner", "demo", "members.manage");
    } catch (error) {
      expect((error as ForbiddenError).code).toBe("DEMO_RESTRICTED");
      expect((error as ForbiddenError).message).toBe(
        "That is not available in the demo workspace.",
      );
    }
  });

  it("an unknown action throws a generic 403 that does not echo the input", () => {
    expect.assertions(2);
    try {
      assertCan("owner", "real", "<script>");
    } catch (error) {
      expect((error as ForbiddenError).message).not.toContain("script");
      expect((error as ForbiddenError).status).toBe(403);
    }
  });
});

describe("granting roles (US-09)", () => {
  it("an owner may grant admin, member, viewer, and owner", () => {
    expect(grantableRoles("owner", "real")).toEqual(["owner", "admin", "member", "viewer"]);
  });
  it("an admin may grant only member and viewer: never admin or owner", () => {
    expect(grantableRoles("admin", "real")).toEqual(["member", "viewer"]);
  });
  it.each(["member", "viewer", "nonsense"])("a %s may grant nothing", (role) => {
    expect(grantableRoles(role, "real")).toEqual([]);
  });
  it("the demo guest may grant nothing", () => {
    expect(grantableRoles("owner", "demo")).toEqual([]);
  });
});

describe("changing or removing a member (US-09)", () => {
  const change = (actorRole: string, from: string, to: string | null, kind = "real") =>
    canChangeMembership({ actorRole, kind, from, to });

  it("an owner may promote a member to admin, to owner, demote an admin, and remove anyone", () => {
    expect(change("owner", "member", "admin").allowed).toBe(true);
    expect(change("owner", "admin", "owner").allowed).toBe(true);
    expect(change("owner", "owner", "admin").allowed).toBe(true);
    expect(change("owner", "viewer", null).allowed).toBe(true);
  });

  it("an owner's change that touches an owner carries the last-owner guard", () => {
    expect(change("owner", "owner", null)).toEqual({
      allowed: true,
      constraints: ["last_owner_guard"],
    });
  });

  it("an admin may set member and viewer and remove non-owners", () => {
    expect(change("admin", "viewer", "member").allowed).toBe(true);
    expect(change("admin", "member", null).allowed).toBe(true);
  });

  it("an admin may not grant admin or owner, or touch an owner", () => {
    expect(change("admin", "member", "admin").allowed).toBe(false);
    expect(change("admin", "member", "owner").allowed).toBe(false);
    expect(change("admin", "owner", "member").allowed).toBe(false);
    expect(change("admin", "owner", null).allowed).toBe(false);
  });

  it("members, viewers, and guests may not change memberships", () => {
    expect(change("member", "viewer", "member").allowed).toBe(false);
    expect(change("viewer", "member", null).allowed).toBe(false);
    expect(change("owner", "viewer", "member", "demo").allowed).toBe(false);
  });

  it("an unknown role on either side denies", () => {
    expect(change("owner", "wizard", "member")).toEqual({ allowed: false, reason: "UNKNOWN_ROLE" });
    expect(change("owner", "member", "wizard")).toEqual({ allowed: false, reason: "UNKNOWN_ROLE" });
  });
});

describe("docs/SECURITY.md stays in sync with the matrix", () => {
  it("contains the generated table between the markers", () => {
    const doc = readFileSync("docs/SECURITY.md", "utf8");
    const start = doc.indexOf("<!-- permissions-matrix:start -->");
    const end = doc.indexOf("<!-- permissions-matrix:end -->");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // Prettier pads table cells and separator rows, so compare with whitespace and dashes normalized.
    const normalize = (text: string) => text.trim().replace(/-{2,}/g, "---").replace(/\s+/g, " ");
    const embedded = doc.slice(start + "<!-- permissions-matrix:start -->".length, end);
    expect(normalize(embedded)).toBe(normalize(renderMatrixMarkdown()));
  });
});

// Compile-time guard documented here: removing a role from a rule, or adding an action to
// ACTIONS without a MATRIX entry, is a type error (`MATRIX ... satisfies Record<Action, ...>`).
const _roleKeysAreExhaustive: Record<Role, true> = {
  owner: true,
  admin: true,
  member: true,
  viewer: true,
};
void _roleKeysAreExhaustive;
