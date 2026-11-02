import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { okItem } from "./envelope";
import { withOrgApi } from "./handler";
import { ORG_HEADER, selectOrg, type MembershipRow } from "./org-context";

const user = { id: "u1", email: "a@example.com", isAnonymous: false };
const A = "a0000000-0000-0000-0000-00000000000a";
const B = "b0000000-0000-0000-0000-00000000000b";
const D = "d0000000-0000-0000-0000-00000000000d";
const now = new Date("2026-11-01T12:00:00Z");

const org = (id: string, over: Partial<NonNullable<MembershipRow["organizations"]>> = {}) => ({
  id,
  name: `Org ${id.slice(0, 1)}`,
  kind: "real",
  expires_at: null,
  timezone: "UTC",
  ...over,
});
const member = (id: string, role = "member", over = {}): MembershipRow => ({
  role,
  organizations: org(id, over),
});

const fails = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e as { status: number; code: string; message: string };
  }
  throw new Error("expected a throw");
};

describe("selectOrg: header present", () => {
  it("picks the named organization and takes the role from the membership", () => {
    const ctx = selectOrg(user, [member(A, "owner"), member(B, "viewer")], B, { now });
    expect(ctx.org.id).toBe(B);
    expect(ctx.role).toBe("viewer");
    expect(ctx.kind).toBe("real");
    expect(ctx.expired).toBe(false);
    expect(ctx.user).toBe(user);
  });
  it("normalizes case and surrounding whitespace", () => {
    expect(selectOrg(user, [member(A)], `  ${A.toUpperCase()} `, { now }).org.id).toBe(A);
  });
  it("a forged id for another tenant is a 404 with the same message as an unknown id", () => {
    const foreign = fails(() => selectOrg(user, [member(A)], B, { now }));
    const unknown = fails(() =>
      selectOrg(user, [member(A)], "99999999-9999-9999-9999-999999999999", { now }),
    );
    expect(foreign.status).toBe(404);
    expect(foreign.code).toBe("ORG_NOT_FOUND");
    expect(unknown.status).toBe(404);
    expect(unknown.message).toBe(foreign.message);
  });
  it("a user with no memberships who names an organization still gets the same 404", () => {
    expect(fails(() => selectOrg(user, [], A, { now })).code).toBe("ORG_NOT_FOUND");
  });
  it("a hidden organization row (RLS said no) never matches", () => {
    expect(
      fails(() => selectOrg(user, [{ role: "owner", organizations: null }], A, { now })).status,
    ).toBe(404);
  });
  it("rejects a malformed id with a 400 before any lookup", () => {
    for (const bad of ["abc", "1; drop table", "../x", "00000000", `${A}x`]) {
      const e = fails(() => selectOrg(user, [member(A)], bad, { now }));
      expect(e.status, bad).toBe(400);
      expect(e.message).toContain(ORG_HEADER);
    }
  });
  it("never reads a role from anywhere but the membership", () => {
    // a membership row with an unexpected role string is passed through as data, never upgraded
    expect(selectOrg(user, [member(A, "viewer")], A, { now }).role).toBe("viewer");
  });
});

describe("selectOrg: header absent", () => {
  it("defaults to the only membership", () => {
    const ctx = selectOrg(user, [member(A, "admin")], null, { now });
    expect(ctx.org.id).toBe(A);
    expect(ctx.role).toBe("admin");
  });
  it("treats an empty or blank header as absent", () => {
    expect(selectOrg(user, [member(A)], "", { now }).org.id).toBe(A);
    expect(selectOrg(user, [member(A)], "   ", { now }).org.id).toBe(A);
  });
  it("asks for an explicit choice (422) when there are several memberships", () => {
    const e = fails(() => selectOrg(user, [member(A), member(B)], null, { now })) as {
      status: number;
      code: string;
      fieldErrors?: Record<string, string[]>;
    };
    expect(e.status).toBe(422);
    expect(e.code).toBe("ORG_SELECTION_REQUIRED");
    expect(e.fieldErrors?.[ORG_HEADER]).toBeTruthy();
  });
  it("says there is no workspace when there are none", () => {
    const e = fails(() => selectOrg(user, [], null, { now }));
    expect(e.status).toBe(404);
    expect(e.code).toBe("NO_WORKSPACE");
  });
  it("counts only organizations the caller can see", () => {
    expect(
      selectOrg(user, [member(A), { role: "owner", organizations: null }], null, { now }).org.id,
    ).toBe(A);
  });
});

describe("selectOrg: demo expiry", () => {
  const live = member(D, "owner", { kind: "demo", expires_at: "2026-11-02T12:00:00Z" });
  const dead = member(D, "owner", { kind: "demo", expires_at: "2026-11-01T11:59:59Z" });
  it("a live demo passes and reports kind demo", () => {
    const ctx = selectOrg(user, [live], null, { now });
    expect(ctx.kind).toBe("demo");
    expect(ctx.expired).toBe(false);
  });
  it("an expired demo is refused with a distinct 403 DEMO_EXPIRED", () => {
    const e = fails(() => selectOrg(user, [dead], null, { now }));
    expect(e.status).toBe(403);
    expect(e.code).toBe("DEMO_EXPIRED");
  });
  it("expiry at exactly now counts as expired; one second later does not", () => {
    expect(
      fails(() =>
        selectOrg(
          user,
          [member(D, "owner", { kind: "demo", expires_at: now.toISOString() })],
          null,
          { now },
        ),
      ).code,
    ).toBe("DEMO_EXPIRED");
    expect(
      selectOrg(
        user,
        [member(D, "owner", { kind: "demo", expires_at: "2026-11-01T12:00:01Z" })],
        null,
        { now },
      ).expired,
    ).toBe(false);
  });
  it("a demo with no expiry is treated as expired (fail closed)", () => {
    expect(
      fails(() =>
        selectOrg(user, [member(D, "owner", { kind: "demo", expires_at: null })], null, { now }),
      ).code,
    ).toBe("DEMO_EXPIRED");
  });
  it("allowExpired returns the context flagged expired, for endpoints that must still answer", () => {
    const ctx = selectOrg(user, [dead], null, { now, allowExpired: true });
    expect(ctx.expired).toBe(true);
    expect(ctx.org.id).toBe(D);
  });
  it("a real organization never expires", () => {
    expect(
      selectOrg(user, [member(A, "owner", { expires_at: "2000-01-01T00:00:00Z" })], null, { now })
        .expired,
    ).toBe(false);
  });
});

describe("withOrgApi", () => {
  const APP = "https://opsdesk.sitelaunch.dev";
  const request = (headers: Record<string, string> = {}) =>
    new NextRequest(`${APP}/api/v1/things`, {
      method: "POST",
      body: "{}",
      headers: { origin: APP, "content-type": "application/json", ...headers },
    });
  const fakeSupabase = (rows: MembershipRow[] | { error: object }) =>
    ({
      from: () => ({
        select: () => ({
          eq: () => ({
            limit: async () =>
              "error" in rows ? { data: null, error: rows.error } : { data: rows, error: null },
          }),
        }),
      }),
    }) as never;
  const api = (rows: MembershipRow[] | { error: object }, extra = {}) =>
    withOrgApi(({ org }) => okItem({ org: org.org.id, role: org.role }), {
      trustedOrigins: () => [APP],
      resolveUser: async () => user,
      createSupabase: async () => fakeSupabase(rows),
      ...extra,
    });

  it("hands the handler a verified org, role and session client", async () => {
    const res = await api([member(A, "admin")])(request());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ org: A, role: "admin" });
  });
  it("401 before any organization work when signed out", async () => {
    const res = await api([member(A)], { resolveUser: async () => null })(request());
    expect(res.status).toBe(401);
  });
  it("404 for a forged header, 422 for several memberships without one, 400 for junk", async () => {
    expect((await api([member(A)])(request({ [ORG_HEADER]: B }))).status).toBe(404);
    const many = await api([member(A), member(B)])(request());
    expect(many.status).toBe(422);
    expect((await many.json()).error.code).toBe("ORG_SELECTION_REQUIRED");
    expect((await api([member(A)])(request({ [ORG_HEADER]: "nope" }))).status).toBe(400);
  });
  it("403 DEMO_EXPIRED for an expired demo, unless the route allows it", async () => {
    const dead = member(D, "owner", { kind: "demo", expires_at: "2000-01-01T00:00:00Z" });
    const res = await api([dead])(request());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("DEMO_EXPIRED");
    expect((await api([dead], { allowExpired: true })(request())).status).toBe(200);
  });
  it("a database error becomes a generic 500, not a leak", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await api({ error: { code: "XX000", message: "relation secret_table failed" } })(
      request(),
    );
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret_table");
  });
});
