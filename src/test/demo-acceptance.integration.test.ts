import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupExpiredDemos } from "@/lib/cleanup/cleanup";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/**
 * [SIT-212] The M1 exit criteria for the public demo, over real HTTP and real PostgREST against the production build
 * and the local Supabase stack: guests A and B bootstrapped together, A attacking B through the API and through direct
 * Supabase queries, escalation attempts, idempotency, throttle, expiry, and a failing CAPTCHA. Re-run it whenever an
 * entity issue lands (the database half is supabase/tests/demo-acceptance.test.sql).
 */
const server = new RealServer();
const BOOT = "/api/v1/demo/bootstrap";
let A: Actor;
let B: Actor;
let orgA = "";
let orgB = "";
let sbA: SupabaseClient;

function sdk(actor: Actor): SupabaseClient {
  const token = JSON.parse(Buffer.from(actor.cookie.split("=base64-")[1], "base64url").toString())
    .access_token as string;
  return createClient(server.supabase.apiUrl, server.supabase.publishableKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
const orgOf = async (res: Response) => (await res.json()).data.organizationId as string;
const admin = () =>
  createClient(server.supabase.apiUrl, server.supabase.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

beforeAll(async () => {
  await server.start();
  [A, B] = await Promise.all([server.guest(), server.guest()]);
  // simultaneous bootstrap through the real endpoint
  const [ra, rb] = await Promise.all([
    server.request(BOOT, A, { method: "POST" }),
    server.request(BOOT, B, { method: "POST" }),
  ]);
  expect([ra.status, rb.status]).toEqual([200, 200]);
  [orgA, orgB] = await Promise.all([orgOf(ra), orgOf(rb)]);
  sbA = sdk(A);
}, 400_000);
afterAll(() => server.stop());

describe("[SIT-212] guests A and B, bootstrapped at the same time", () => {
  it("get different organizations, each seeded with the same demo version and no shared rows", () => {
    expect(orgA).not.toBe(orgB);
    const versions = psql(
      `select count(distinct seed_version) || ':' || count(*) from public.demo_workspaces where organization_id in ('${orgA}','${orgB}')`,
    );
    expect(versions).toBe("1:2");
    expect(
      Number(
        psql(
          `select count(*) from public.memberships where organization_id = '${orgA}' and user_id = '${B.id}'`,
        ),
      ),
    ).toBe(0);
  });

  it("repeated bootstrap is idempotent, with or without a key", async () => {
    for (const headers of [
      {} as Record<string, string>,
      { "Idempotency-Key": "accept-0000-aaaa-1111" },
      { "Idempotency-Key": "accept-0000-aaaa-1111" },
    ]) {
      expect(await orgOf(await server.request(BOOT, A, { method: "POST", headers }))).toBe(orgA);
    }
    expect(Number(psql(`select count(*) from public.memberships where user_id = '${A.id}'`))).toBe(
      1,
    );
  });
});

describe("[SIT-212] A cannot reach B's records (REST API and direct Supabase queries)", () => {
  it("REST API: B's organization is a 404 for A, identical to an unknown id; A's own list holds only A's", async () => {
    const other = await server.request(`/api/v1/organizations/${orgB}`, A);
    const unknown = await server.request(`/api/v1/organizations/${crypto.randomUUID()}`, A);
    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect((await other.json()).error.code).toBe((await unknown.json()).error.code);
    const list = await (await server.request("/api/v1/organizations", A)).json();
    expect(list.data.map((o: { id: string }) => o.id)).toEqual([orgA]);
    const session = await (await server.request("/api/v1/session", A)).json();
    expect(session.data.organizations.map((o: { id: string }) => o.id)).toEqual([orgA]);
  });

  it("direct queries: A fetches, enumerates, updates and deletes B's records and gets nothing", async () => {
    expect((await sbA.from("organizations").select("*").eq("id", orgB)).data).toEqual([]);
    expect((await sbA.from("organizations").select("id")).data).toEqual([{ id: orgA }]);
    expect((await sbA.from("memberships").select("*").eq("organization_id", orgB)).data).toEqual(
      [],
    );
    expect(
      (await sbA.from("demo_workspaces").select("*").eq("organization_id", orgB)).data,
    ).toEqual([]);
    expect((await sbA.from("profiles").select("id").eq("id", B.id)).data).toEqual([]);
    const upd = await sbA
      .from("organizations")
      .update({ name: "hijacked" })
      .eq("id", orgB)
      .select();
    expect(upd.data ?? []).toEqual([]);
    const del = await sbA.from("organizations").delete().eq("id", orgB).select();
    expect(del.data ?? []).toEqual([]);
    expect(psql(`select name from public.organizations where id = '${orgB}'`)).toBe(
      "Demo Workspace",
    );
  });

  it("A cannot reset B's demo: it reports not found, like an unknown id, and B's data is untouched", async () => {
    const other = await sbA.rpc("reset_demo_workspace", { org_id: orgB });
    const unknown = await sbA.rpc("reset_demo_workspace", { org_id: crypto.randomUUID() });
    expect(other.error?.code).toBe("OD404");
    expect(unknown.error?.code).toBe("OD404");
    expect(other.error?.message).toBe(unknown.error?.message);
  });
});

describe("[SIT-212] A cannot escalate", () => {
  it("cannot create a real organization (API and function)", async () => {
    const api = await server.request("/api/v1/organizations", A, { json: { name: "Mine Co" } });
    expect(api.status).toBe(403);
    const fn = await sbA.rpc("create_real_organization", {
      org_name: "Mine Co",
      org_industry: null,
      org_timezone: "UTC",
    });
    expect(fn.error?.code).toBe("OD403");
    expect(
      Number(
        psql(
          `select count(*) from public.organizations where created_by = '${A.id}' and kind = 'real'`,
        ),
      ),
    ).toBe(0);
  });

  it("cannot invite a member, edit a role, or extend the expiry", async () => {
    const before = psql(`select expires_at from public.organizations where id = '${orgA}'`);
    const invite = await sbA
      .from("memberships")
      .insert({ organization_id: orgA, user_id: B.id, role: "member" });
    expect(invite.error).not.toBeNull();
    const role = await sbA
      .from("memberships")
      .update({ role: "viewer" })
      .eq("organization_id", orgA)
      .select();
    expect(role.error !== null || (role.data ?? []).length === 0).toBe(true);
    const extend = await sbA
      .from("organizations")
      .update({ expires_at: "2099-01-01T00:00:00Z" })
      .eq("id", orgA)
      .select();
    expect(extend.error !== null || (extend.data ?? []).length === 0).toBe(true);
    const real = await sbA
      .from("organizations")
      .update({ kind: "real", expires_at: null })
      .eq("id", orgA)
      .select();
    expect(real.error !== null || (real.data ?? []).length === 0).toBe(true);
    expect(psql(`select expires_at from public.organizations where id = '${orgA}'`)).toBe(before);
    expect(
      psql(
        `select role || ':' || count(*) from public.memberships where organization_id = '${orgA}' group by role`,
      ),
    ).toBe("owner:1");
  });

  it("cannot call any administrator, cleanup or seeding function", async () => {
    for (const [fn, args] of [
      ["cleanup_purge_expired_demos", { batch_size: 10 }],
      ["cleanup_next_users", { max_rows: 5, attempted_before: new Date().toISOString() }],
      ["cleanup_user_eligible", { uid: B.id }],
      ["cleanup_purge_expired_keys", {}],
      ["seed_demo_workspace", { org_id: orgB }],
      ["register_demo_workspace", { org_id: orgA, user_id: A.id }],
    ] as const) {
      const res = await sbA.rpc(fn, args);
      expect(res.error, fn).not.toBeNull();
      expect(res.data, fn).toBeNull();
    }
    const anon = createClient(server.supabase.apiUrl, server.supabase.publishableKey, {
      auth: { persistSession: false },
    });
    expect(
      (await anon.rpc("cleanup_purge_expired_demos", { batch_size: 10 })).error,
    ).not.toBeNull();
    expect((await anon.rpc("bootstrap_demo_workspace")).error).not.toBeNull();
  });

  it("a registered user gets no demo workspace", async () => {
    const member = await server.member("accept");
    expect((await server.request(BOOT, member, { method: "POST" })).status).toBe(403);
    expect(
      Number(psql(`select count(*) from public.memberships where user_id = '${member.id}'`)),
    ).toBe(0);
  });
});

describe("[SIT-212] repeated reset is bounded", () => {
  it("a first reset works and an immediate second is throttled with 429", async () => {
    const guest = await server.guest();
    const org = await orgOf(await server.request(BOOT, guest, { method: "POST" }));
    const sb = sdk(guest);
    const first = await sb.rpc("reset_demo_workspace", { org_id: org });
    expect(first.error).toBeNull();
    const second = await sb.rpc("reset_demo_workspace", { org_id: org });
    expect(second.error?.code).toBe("OD429");
  });
});

describe("[SIT-212] an expired guest", () => {
  it("gets the expiry response, cannot write, loses only their own workspace to cleanup, and can start a fresh demo", async () => {
    const [dead, bystander] = await Promise.all([server.guest(), server.guest()]);
    const deadOrg = await orgOf(await server.request(BOOT, dead, { method: "POST" }));
    const liveOrg = await orgOf(await server.request(BOOT, bystander, { method: "POST" }));
    psql(
      `update public.organizations set expires_at = now() - interval '1 minute' where id = '${deadOrg}'`,
    );

    const session = await (await server.request("/api/v1/session", dead)).json();
    expect(session.data.demo).toMatchObject({
      organizationId: deadOrg,
      expired: true,
      secondsRemaining: 0,
    });
    const rename = await sdk(dead)
      .from("organizations")
      .update({ name: "late" })
      .eq("id", deadOrg)
      .select();
    expect(rename.data ?? []).toEqual([]);
    expect(psql(`select name from public.organizations where id = '${deadOrg}'`)).toBe(
      "Demo Workspace",
    );

    const result = await cleanupExpiredDemos(admin() as never, { log: () => undefined });
    expect(result.errorCodes).toEqual([]);
    expect(Number(psql(`select count(*) from public.organizations where id = '${deadOrg}'`))).toBe(
      0,
    );
    expect(Number(psql(`select count(*) from public.organizations where id = '${liveOrg}'`))).toBe(
      1,
    );
    expect(Number(psql(`select count(*) from public.organizations where id = '${orgA}'`))).toBe(1);

    // Phase two of cleanup removes the guest too (anonymous, no membership left), so their old session is dead and
    // they start again as a fresh visitor; either way a fresh demo can start and is a new workspace.
    const stillThere =
      Number(psql(`select count(*) from auth.users where id = '${dead.id}'`)) === 1;
    const oldSession = await server.request(BOOT, dead, { method: "POST" });
    expect(oldSession.status).toBe(stillThere ? 200 : 401);
    const visitor = await server.guest();
    const fresh = await server.request(BOOT, visitor, { method: "POST" });
    expect(fresh.status).toBe(200);
    const body = await fresh.json();
    expect(body.data.created).toBe(true);
    expect([deadOrg, liveOrg, orgA, orgB]).not.toContain(body.data.organizationId);
  });
});

describe("[SIT-212] CAPTCHA required but missing or unusable", () => {
  const users = () => Number(psql("select count(*) from auth.users"));
  const signUp = (body: unknown) =>
    fetch(`${server.supabase.apiUrl}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: server.supabase.publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("anonymous sign-in with no token, an empty token or a null token is refused and creates no account", async () => {
    const before = users();
    for (const body of [
      {},
      { gotrue_meta_security: {} },
      { gotrue_meta_security: { captcha_token: "" } },
      { gotrue_meta_security: { captcha_token: null } },
    ]) {
      const res = await signUp(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error_code).toBe("captcha_failed");
    }
    expect(users()).toBe(before);
  });

  it("the bootstrap endpoint creates nothing for a visitor with no session", async () => {
    const before = users();
    const res = await server.request(BOOT, null, { method: "POST" });
    expect(res.status).toBe(401);
    expect(users()).toBe(before);
    expect(
      Number(
        psql(
          "select count(*) from public.demo_workspaces where user_id not in (select id from auth.users)",
        ),
      ),
    ).toBe(0);
  });
});
