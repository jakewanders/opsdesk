import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";
import { cleanupExpiredDemos, type CleanupResult } from "./cleanup";

/**
 * The cleanup against the local stack with mixed fixtures: expired demos (several), an active demo, a real
 * organization with a real user, and stray guests. The admin client is the real secret-key client.
 */
const run = Date.now();
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
let supabase: LocalSupabase;
let admin: SupabaseClient;
const created: string[] = [];
const silent = () => undefined;

type Guest = { id: string; org: string };
const userExists = (id: string) =>
  Number(psql(`select count(*) from auth.users where id = '${id}'`)) === 1;
const orgExists = (id: string) =>
  Number(psql(`select count(*) from public.organizations where id = '${id}'`)) === 1;

async function guest(): Promise<Guest> {
  const c = createClient(supabase.apiUrl, supabase.publishableKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await c.auth.signInAnonymously({ options: { captchaToken: TOKEN } });
  expect(error).toBeNull();
  created.push(data.user!.id);
  const boot = await c.rpc("bootstrap_demo_workspace");
  expect(boot.error).toBeNull();
  return { id: data.user!.id, org: (boot.data as { organization_id: string }).organization_id };
}
const expire = (g: Guest) =>
  psql(
    `update public.organizations set expires_at = now() - interval '1 minute' where id = '${g.org}'`,
  );
// Only this file's own data may be touched by assertions about "nothing else changed"
const mine = () => created.map((i) => `'${i}'`).join(",");

beforeAll(() => {
  supabase = localSupabase();
  admin = createClient(supabase.apiUrl, supabase.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
});
beforeEach(() => {
  // start every test with the queue and any leftover expired demos from other runs removed
  psql(`delete from private.demo_cleanup_users`);
});
afterAll(() => {
  if (created.length) {
    psql(`delete from public.organizations where created_by in (${mine()})`);
    psql(`delete from auth.users where id in (${mine()})`);
  }
  psql(`delete from private.demo_cleanup_users`);
});

async function runCleanup(overrides: Partial<Parameters<typeof cleanupExpiredDemos>[1]> = {}) {
  return cleanupExpiredDemos(admin as never, { log: silent, ...overrides });
}

describe("cleanupExpiredDemos with mixed fixtures", () => {
  it("deletes expired demos and their guests, leaves an active demo, a real org and a real user untouched, and is idempotent", async () => {
    const [dead1, dead2, live] = await Promise.all([guest(), guest(), guest()]);
    expire(dead1);
    expire(dead2);
    const email = `cleanup-real-${run}@example.test`;
    const make = await fetch(`${supabase.apiUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: supabase.secretKey,
        Authorization: `Bearer ${supabase.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password: "correct horse battery", email_confirm: true }),
    });
    const { id: realUser } = (await make.json()) as { id: string };
    created.push(realUser);
    const rc = createClient(supabase.apiUrl, supabase.publishableKey, {
      auth: { persistSession: false },
    });
    await rc.auth.signInWithPassword({
      email,
      password: "correct horse battery",
      options: { captchaToken: TOKEN },
    });
    const realOrg = (
      await rc.rpc("create_real_organization", {
        org_name: "Cleanup Real Co",
        org_industry: null,
        org_timezone: "UTC",
      })
    ).data as string;

    const first = await runCleanup();
    expect(first.errors).toBe(0);
    expect(first.orgsDeleted).toBeGreaterThanOrEqual(2);
    expect(first.usersDeleted).toBeGreaterThanOrEqual(2);
    expect(orgExists(dead1.org)).toBe(false);
    expect(orgExists(dead2.org)).toBe(false);
    expect(userExists(dead1.id)).toBe(false);
    expect(userExists(dead2.id)).toBe(false);
    // untouched
    expect(orgExists(live.org)).toBe(true);
    expect(userExists(live.id)).toBe(true);
    expect(orgExists(realOrg)).toBe(true);
    expect(userExists(realUser)).toBe(true);
    expect(
      Number(
        psql(
          `select count(*) from public.memberships where organization_id = '${realOrg}' and user_id = '${realUser}'`,
        ),
      ),
    ).toBe(1);
    expect(
      Number(psql(`select count(*) from public.memberships where organization_id = '${live.org}'`)),
    ).toBe(1);

    const second = await runCleanup();
    expect(second.orgsDeleted).toBe(0);
    expect(second.usersDeleted).toBe(0);
    expect(second.errors).toBe(0);
    expect(
      orgExists(live.org) && userExists(live.id) && orgExists(realOrg) && userExists(realUser),
    ).toBe(true);
  });

  it("a registered user whose expired demo is removed keeps their account", async () => {
    const email = `cleanup-keep-${run}@example.test`;
    const make = await fetch(`${supabase.apiUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: supabase.secretKey,
        Authorization: `Bearer ${supabase.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password: "correct horse battery", email_confirm: true }),
    });
    const { id } = (await make.json()) as { id: string };
    created.push(id);
    // an (unusual) expired demo owned by a registered user: the organization may go, the account must not
    psql(`insert into public.organizations (id, name, kind, expires_at, created_by) values ('d7000000-0000-4000-8000-0000000000d7', 'Registered demo', 'demo', now() + interval '1 hour', '${id}');
      insert into public.memberships (organization_id, user_id, role) values ('d7000000-0000-4000-8000-0000000000d7', '${id}', 'owner');
      update public.organizations set expires_at = now() - interval '1 minute' where id = 'd7000000-0000-4000-8000-0000000000d7';`);
    const res = await runCleanup();
    expect(res.errors).toBe(0);
    expect(orgExists("d7000000-0000-4000-8000-0000000000d7")).toBe(false);
    expect(userExists(id)).toBe(true);
    expect(res.usersSkipped).toBeGreaterThanOrEqual(1);
  });

  it("a guest who is still a member of an unexpired demo is never deleted, even if queued", async () => {
    const live = await guest();
    psql(`insert into private.demo_cleanup_users (user_id) values ('${live.id}')`);
    const res = await runCleanup();
    expect(userExists(live.id)).toBe(true);
    expect(orgExists(live.org)).toBe(true);
    expect(res.usersSkipped).toBeGreaterThanOrEqual(1);
    expect(
      Number(psql(`select count(*) from private.demo_cleanup_users where user_id = '${live.id}'`)),
    ).toBe(0);
  });

  it("respects the batch size: three expired demos with batch size 2 take two batches", async () => {
    const gs = await Promise.all([guest(), guest(), guest()]);
    gs.forEach(expire);
    const res = await runCleanup({ batchSize: 2 });
    expect(res.orgsDeleted).toBeGreaterThanOrEqual(3);
    expect(res.batches).toBeGreaterThanOrEqual(2);
    for (const g of gs) expect(orgExists(g.org)).toBe(false);
  });

  it("handles 200+ expired demos in bounded batches, touching nothing else, then is a no-op", async () => {
    const tag = `bulk${run}`;
    const live = await guest();
    const uid = (i: string) =>
      `('b${String(run % 10000000).padStart(7, "0")}-0000-4000-8000-' || lpad(${i}::text, 12, '0'))::uuid`;
    psql(`
      insert into auth.users (instance_id, id, aud, role, email, is_anonymous, created_at, updated_at,
          confirmation_token, recovery_token, email_change_token_new, email_change)
        select '00000000-0000-0000-0000-000000000000',  ${uid("i")}, 'authenticated', 'authenticated', null, true, now(), now(), '', '', '', '' from generate_series(1, 220) i;
      insert into public.organizations (id, name, kind, expires_at, created_by)
        select gen_random_uuid(), '${tag} ' || i, 'demo', now() + interval '1 hour', ${uid("i")} from generate_series(1, 220) i;
      insert into public.memberships (organization_id, user_id, role)
        select o.id, o.created_by, 'owner' from public.organizations o where o.name like '${tag} %';
      select private.register_demo_workspace(o.id, o.created_by) from public.organizations o where o.name like '${tag} %';
      update public.organizations set expires_at = now() - interval '1 minute' where name like '${tag} %';
    `);
    const count = () =>
      Number(psql(`select count(*) from public.organizations where name like '${tag} %'`));
    expect(count()).toBe(220);
    // Each run is bounded by the time budget; 220 demos plus their guests may need several runs.
    let deleted = 0;
    let batches = 0;
    for (let i = 0; i < 10 && count() > 0; i++) {
      const res = await runCleanup({ batchSize: 50 });
      expect(res.errorCodes).toEqual([]);
      deleted += res.orgsDeleted;
      batches += res.batches;
    }
    expect(deleted).toBeGreaterThanOrEqual(220);
    expect(batches).toBeGreaterThanOrEqual(5);
    expect(count()).toBe(0);
    expect(orgExists(live.org)).toBe(true); // an active demo, untouched
    expect(userExists(live.id)).toBe(true);
    // finish the guest deletions still queued, then the next run has nothing to do
    for (let i = 0; i < 10; i++) await runCleanup({ batchSize: 50 });
    expect((await runCleanup({ batchSize: 50 })).orgsDeleted).toBe(0);
    expect(
      Number(
        psql(
          `select count(*) from auth.users where id::text like 'b${String(run % 10000000).padStart(7, "0")}-%'`,
        ),
      ),
    ).toBe(0);
  }, 240_000);

  it("an anonymous guest who also belongs to a real organization is skipped, and the real organization survives", async () => {
    const g = await guest();
    const owner = createClient(supabase.apiUrl, supabase.publishableKey, {
      auth: { persistSession: false },
    });
    const email = `cleanup-edge-${run}@example.test`;
    const make = await fetch(`${supabase.apiUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: supabase.secretKey,
        Authorization: `Bearer ${supabase.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password: "correct horse battery", email_confirm: true }),
    });
    const { id: ownerId } = (await make.json()) as { id: string };
    created.push(ownerId);
    void owner;
    const realOrg = crypto.randomUUID();
    psql(`
      insert into public.organizations (id, name, kind, created_by) values ('${realOrg}', 'Edge Co ${run}', 'real', '${ownerId}');
      insert into public.memberships (organization_id, user_id, role) values ('${realOrg}', '${ownerId}', 'owner'), ('${realOrg}', '${g.id}', 'member');
    `);
    expire(g);
    const res = await runCleanup();
    expect(res.errors).toBe(0);
    expect(orgExists(g.org)).toBe(false); // the expired demo itself is removed
    expect(orgExists(realOrg)).toBe(true);
    expect(userExists(g.id)).toBe(true); // still a member of a real organization: not deleted
    expect(userExists(ownerId)).toBe(true);
    expect(
      Number(psql(`select count(*) from public.memberships where organization_id = '${realOrg}'`)),
    ).toBe(2);
    psql(`delete from public.organizations where id = '${realOrg}'`);
  });

  it("respects the time budget and finishes the work on the next run", async () => {
    const gs = await Promise.all([guest(), guest(), guest()]);
    gs.forEach(expire);
    let t = 0;
    const clock = () => (t += 1000); // every check costs a second
    const partial = await runCleanup({ batchSize: 1, timeBudgetMs: 2500, clock });
    expect(partial.truncated).toBe(true);
    expect(partial.orgsDeleted).toBeLessThan(3);
    const remainingOrgs = gs.filter((g) => orgExists(g.org)).length;
    expect(remainingOrgs).toBeGreaterThan(0);
    // a second, unconstrained run completes everything and is then idempotent
    const done = await runCleanup();
    expect(done.errors).toBe(0);
    for (const g of gs) {
      expect(orgExists(g.org)).toBe(false);
      expect(userExists(g.id)).toBe(false);
    }
    expect((await runCleanup()).orgsDeleted).toBe(0);
  });

  it("a phase-2 failure leaves a retry candidate and does not block phase 1; the next run retries it", async () => {
    const [a, b] = await Promise.all([guest(), guest()]);
    expire(a);
    expire(b);
    const flaky = {
      rpc: admin.rpc.bind(admin),
      auth: {
        admin: {
          deleteUser: async (id: string) =>
            id === a.id
              ? { error: { code: "unexpected_failure", status: 500 } }
              : admin.auth.admin.deleteUser(id),
        },
      },
    };
    const res = await cleanupExpiredDemos(flaky as never, { log: silent });
    // phase 1 completed for both organizations
    expect(orgExists(a.org)).toBe(false);
    expect(orgExists(b.org)).toBe(false);
    // the healthy guest was deleted, the failing one is still there and queued with its error code
    expect(userExists(b.id)).toBe(false);
    expect(userExists(a.id)).toBe(true);
    expect(res.errors).toBe(1);
    expect(res.errorCodes).toContain("unexpected_failure");
    expect(res.retryCandidates).toBeGreaterThanOrEqual(1);
    expect(
      psql(
        `select attempts || ':' || last_error from private.demo_cleanup_users where user_id = '${a.id}'`,
      ),
    ).toBe("1:unexpected_failure");

    const retry = await runCleanup();
    expect(retry.errors).toBe(0);
    expect(userExists(a.id)).toBe(false);
    expect(
      Number(psql(`select count(*) from private.demo_cleanup_users where user_id = '${a.id}'`)),
    ).toBe(0);
  });

  it("a user the database cannot prove safe is left alone and queued (fail closed)", async () => {
    const live = await guest();
    psql(`insert into private.demo_cleanup_users (user_id) values ('${live.id}')`);
    const unsure = {
      rpc: async (fn: string, args?: object) =>
        fn === "cleanup_user_eligible"
          ? { data: null, error: { code: "57014" } }
          : admin.rpc(fn, args as never),
      auth: admin.auth,
    };
    const res = await cleanupExpiredDemos(unsure as never, { log: silent });
    expect(userExists(live.id)).toBe(true);
    expect(res.errors).toBeGreaterThanOrEqual(1);
    expect(
      Number(psql(`select count(*) from private.demo_cleanup_users where user_id = '${live.id}'`)),
    ).toBe(1);
  });

  it("an old guest with no organization is queued as an orphan and removed; a fresh one is not", async () => {
    const c = createClient(supabase.apiUrl, supabase.publishableKey, {
      auth: { persistSession: false },
    });
    const old = (await c.auth.signInAnonymously({ options: { captchaToken: TOKEN } })).data.user!
      .id;
    const fresh = (
      await createClient(supabase.apiUrl, supabase.publishableKey, {
        auth: { persistSession: false },
      }).auth.signInAnonymously({ options: { captchaToken: TOKEN } })
    ).data.user!.id;
    created.push(old, fresh);
    psql(`update auth.users set created_at = now() - interval '4 days' where id = '${old}'`);
    const res = await runCleanup();
    expect(res.orphansQueued).toBeGreaterThanOrEqual(1);
    expect(userExists(old)).toBe(false);
    expect(userExists(fresh)).toBe(true);
  });

  it("logs counts and error codes only, never ids, emails or messages", async () => {
    const g = await guest();
    expire(g);
    const events: Record<string, unknown>[] = [];
    const res: CleanupResult = await cleanupExpiredDemos(admin as never, {
      log: (e) => events.push(e),
    });
    expect(events).toHaveLength(1);
    const line = JSON.stringify(events[0]);
    expect(line).toContain("demo_cleanup");
    expect(line).not.toContain(g.id);
    expect(line).not.toContain(g.org);
    expect(line).not.toMatch(/@/);
    expect(Object.keys(events[0]).sort()).toEqual(
      [
        "batches",
        "durationMs",
        "errorCodes",
        "errors",
        "event",
        "expiredKeysPurged",
        "orgsDeleted",
        "orphansQueued",
        "retryCandidates",
        "truncated",
        "usersDeleted",
        "usersSkipped",
      ].sort(),
    );
    expect(res.orgsDeleted).toBeGreaterThanOrEqual(1);
  });
});
