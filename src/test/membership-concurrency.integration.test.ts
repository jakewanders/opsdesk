import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/**
 * SIT-202: the last-owner guard under real concurrency. Two owners demote each other (or remove each other) at the same
 * instant, through PostgREST with each user's own access token, many rounds. At least one owner must always remain, and
 * exactly one of each pair of calls must be refused with OD409 (HTTP 409).
 */
const server = new RealServer();
let alice: Actor;
let bob: Actor;
let viewer: Actor;
let guest: Actor;
let org = "";

const token = (a: Actor) =>
  JSON.parse(Buffer.from(a.cookie.split("=base64-")[1], "base64url").toString())
    .access_token as string;

type Out = { ok: boolean; code: string | null; body: Record<string, unknown> };

/** PostgREST answers a custom SQLSTATE (OD403...) with HTTP 400 and the code in the body, so tests compare the code. */
async function rpc(a: Actor, fn: string, body: Record<string, unknown>): Promise<Out> {
  const res = await fetch(`${server.supabase.apiUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: server.supabase.publishableKey,
      Authorization: `Bearer ${token(a)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, code: res.ok ? null : String(json.code ?? res.status), body: json };
}

const owners = () =>
  Number(
    psql(
      `select count(*) from public.memberships where organization_id = '${org}' and role = 'owner'`,
    ),
  );
const setRole = (user: string, role: string) =>
  psql(
    `set session_replication_role = replica; insert into public.memberships (organization_id, user_id, role) values ('${org}', '${user}', '${role}') on conflict (organization_id, user_id) do update set role = excluded.role`,
  );

beforeAll(async () => {
  await server.start();
  [alice, bob, viewer, guest] = await Promise.all([
    server.member("owner-a"),
    server.member("owner-b"),
    server.member("viewer"),
    server.guest(),
  ]);
  const res = await server.request("/api/v1/organizations", alice, {
    json: { name: "Concurrency Co", industry: "Test", timezone: "America/New_York" },
  });
  org = ((await res.json()) as { data: { id: string } }).data.id;
  setRole(bob.id, "owner");
  setRole(viewer.id, "viewer");
}, 400_000);

afterAll(() => server.stop());

describe("change_membership under concurrency", () => {
  it("two owners demoting each other never leaves zero owners", async () => {
    for (let round = 0; round < 12; round++) {
      setRole(alice.id, "owner");
      setRole(bob.id, "owner");
      const [a, b] = await Promise.all([
        rpc(alice, "change_membership", { p_org_id: org, p_user_id: bob.id, p_new_role: "member" }),
        rpc(bob, "change_membership", { p_org_id: org, p_user_id: alice.id, p_new_role: "member" }),
      ]);
      expect(owners(), `round ${round}`).toBeGreaterThanOrEqual(1);
      // one call wins; the other either sees the first's result (a member cannot manage: OD403) or hits the guard (OD409)
      expect([a, b].filter((r) => r.ok)).toHaveLength(1);
      expect(["OD403", "OD409"]).toContain([a, b].find((r) => !r.ok)?.code);
    }
  });

  it("two owners removing each other never leaves zero owners", async () => {
    for (let round = 0; round < 12; round++) {
      setRole(alice.id, "owner");
      setRole(bob.id, "owner");
      const [a, b] = await Promise.all([
        rpc(alice, "change_membership", { p_org_id: org, p_user_id: bob.id, p_remove: true }),
        rpc(bob, "change_membership", { p_org_id: org, p_user_id: alice.id, p_remove: true }),
      ]);
      expect(owners(), `round ${round}`).toBeGreaterThanOrEqual(1);
      expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    }
  });

  it("the sole remaining owner is refused with OD409", async () => {
    setRole(bob.id, "member");
    setRole(alice.id, "owner");
    const res = await rpc(alice, "change_membership", {
      p_org_id: org,
      p_user_id: alice.id,
      p_new_role: "admin",
    });
    expect(res.code).toBe("OD409");
    expect(owners()).toBe(1);
  });
});

describe("the membership RPCs over PostgREST", () => {
  it("a viewer cannot invite or change roles (OD403)", async () => {
    const inv = await rpc(viewer, "create_invitation", {
      p_org_id: org,
      p_email: "x@example.com",
      p_role: "member",
    });
    expect(inv.code).toBe("OD403");
    const chg = await rpc(viewer, "change_membership", {
      p_org_id: org,
      p_user_id: bob.id,
      p_new_role: "owner",
    });
    expect(chg.code).toBe("OD403");
  });

  it("a demo guest cannot call any of them (OD403)", async () => {
    for (const [fn, body] of [
      ["create_invitation", { p_org_id: org, p_email: "x@example.com", p_role: "member" }],
      ["change_membership", { p_org_id: org, p_user_id: bob.id, p_new_role: "owner" }],
      ["redeem_invitation", { p_token: "a".repeat(64) }],
      ["revoke_invitation", { p_invitation_id: "00000000-0000-4000-8000-000000000000" }],
    ] as const) {
      expect((await rpc(guest, fn, body)).code, fn).toBe("OD403");
    }
  });

  it("an anonymous (no-session) caller is refused", async () => {
    const res = await fetch(`${server.supabase.apiUrl}/rest/v1/rpc/redeem_invitation`, {
      method: "POST",
      headers: {
        apikey: server.supabase.publishableKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_token: "a".repeat(64) }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it("an invitation is created, redeemed by the matching verified user, and cannot be used twice", async () => {
    // the viewer must not already belong to the workspace to be invited into it
    psql(
      `delete from public.memberships where organization_id = '${org}' and user_id = '${viewer.id}'`,
    );
    const created = await rpc(alice, "create_invitation", {
      p_org_id: org,
      p_email: viewer.email,
      p_role: "member",
    });
    expect(created.ok).toBe(true);
    const t = created.body.token as string;
    const first = await rpc(viewer, "redeem_invitation", { p_token: t });
    expect(first.body).toMatchObject({ ok: true, organizationId: org });
    const second = await rpc(viewer, "redeem_invitation", { p_token: t });
    expect(second.body).toEqual({ ok: false, reason: "used" });
  });
});
