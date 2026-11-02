import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorResponse } from "@/lib/api/envelope";
import { toApiError } from "@/lib/api/to-api-error";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";

/** reset_demo_workspace() through PostgREST with real anonymous sessions and a probe seeder (entities arrive in M2). */
const run = Date.now();
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
let supabase: LocalSupabase;
const userIds: string[] = [];

const client = () =>
  createClient(supabase.apiUrl, supabase.publishableKey, { auth: { persistSession: false } });
async function guest() {
  const c = client();
  const { data, error } = await c.auth.signInAnonymously({ options: { captchaToken: TOKEN } });
  expect(error).toBeNull();
  userIds.push(data.user!.id);
  const boot = await c.rpc("bootstrap_demo_workspace");
  expect(boot.error).toBeNull();
  return { c, id: data.user!.id, org: (boot.data as { organization_id: string }).organization_id };
}
const reset = (c: SupabaseClient, org: string) => c.rpc("reset_demo_workspace", { org_id: org });
const rows = (org: string) =>
  psql(
    `select string_agg(n || ':' || label, '|' order by n) from public.zz_reset_probe where org_id = '${org}'`,
  );
const waitReady = (org: string) =>
  psql(
    `update public.demo_workspaces set last_reset_at = now() - interval '2 minutes' where organization_id = '${org}'`,
  );

beforeAll(() => {
  supabase = localSupabase();
  psql(`
    create table public.zz_reset_probe (id uuid primary key default gen_random_uuid(), org_id uuid not null, n integer not null, label text not null);
    create function private.zz_reset_seed(org uuid) returns void language sql as $$ insert into public.zz_reset_probe (org_id, n, label) select org, i, private.demo_company(i) from generate_series(1, 4) i $$;
    create function private.zz_reset_clear(org uuid) returns void language sql as $$ delete from public.zz_reset_probe where org_id = org $$;
    select private.register_demo_seeder('zz_reset', 10, 'private.zz_reset_seed(uuid)'::regprocedure, 1, 'private.zz_reset_clear(uuid)'::regprocedure);
  `);
});
afterAll(() => {
  psql(
    `delete from private.demo_seeders where name = 'zz_reset'; drop table if exists public.zz_reset_probe; drop function if exists private.zz_reset_seed(uuid), private.zz_reset_clear(uuid)`,
  );
  if (userIds.length) {
    const list = userIds.map((i) => `'${i}'`).join(",");
    psql(`delete from public.organizations where created_by in (${list})`);
    psql(`delete from auth.users where id in (${list})`);
  }
});

describe("reset_demo_workspace over the API", () => {
  it("restores the exact seed, keeps the org and its expiry, and bounds repeats", async () => {
    const g = await guest();
    const seeded = rows(g.org);
    expect(seeded.split("|")).toHaveLength(4);
    const expiryBefore = psql(`select expires_at from public.organizations where id = '${g.org}'`);
    psql(
      `insert into public.zz_reset_probe (org_id, n, label) values ('${g.org}', 99, 'junk'); update public.zz_reset_probe set label = 'edited' where org_id = '${g.org}' and n = 1`,
    );
    expect(rows(g.org)).not.toBe(seeded);

    const res = await reset(g.c, g.org);
    expect(res.error).toBeNull();
    expect(rows(g.org)).toBe(seeded);
    expect(psql(`select expires_at from public.organizations where id = '${g.org}'`)).toBe(
      expiryBefore,
    );

    const again = await reset(g.c, g.org);
    expect(again.error?.code).toBe("OD429");
    const { apiError } = toApiError(again.error);
    const response = errorResponse(apiError, "req-reset");
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("DEMO_RESET_THROTTLED");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("RACE: two simultaneous resets of one workspace let exactly one through", async () => {
    const g = await guest();
    const [a, b] = await Promise.all([reset(g.c, g.org), reset(g.c, g.org)]);
    const outcomes = [a, b].map((r) => (r.error ? r.error.code : "ok")).sort();
    expect(outcomes).toEqual(["OD429", "ok"]);
    expect(rows(g.org).split("|")).toHaveLength(4);
  });

  it("another guest's id and an unknown id are the same not-found, and change nothing", async () => {
    const [x, y] = await Promise.all([guest(), guest()]);
    psql(`update public.zz_reset_probe set label = 'x-work' where org_id = '${x.org}' and n = 1`);
    const foreign = await reset(y.c, x.org);
    const unknown = await reset(y.c, "00000000-0000-0000-0000-000000000000");
    expect(foreign.error?.code).toBe("OD404");
    expect(unknown.error?.message).toBe(foreign.error?.message);
    expect(rows(x.org)).toContain("1:x-work");
  });

  it("a registered user is rejected (a real organization is never reset)", async () => {
    const email = `reset-${run}@example.test`;
    const created = await fetch(`${supabase.apiUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: supabase.secretKey,
        Authorization: `Bearer ${supabase.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password: "correct horse battery", email_confirm: true }),
    });
    const { id } = (await created.json()) as { id: string };
    userIds.push(id);
    const m = client();
    await m.auth.signInWithPassword({
      email,
      password: "correct horse battery",
      options: { captchaToken: TOKEN },
    });
    const org = (
      await m.rpc("create_real_organization", {
        org_name: "Real Co",
        org_industry: null,
        org_timezone: "UTC",
      })
    ).data as string;
    psql(`insert into public.zz_reset_probe (org_id, n, label) values ('${org}', 1, 'real data')`);
    const res = await reset(m, org);
    expect(res.error?.code).toBe("OD403");
    expect(rows(org)).toBe("1:real data");
    psql(`delete from public.zz_reset_probe where org_id = '${org}'`);
  });

  it("an expired demo cannot be reset, and the anon key cannot call it", async () => {
    const g = await guest();
    psql(
      `update public.organizations set expires_at = now() - interval '1 minute' where id = '${g.org}'`,
    );
    waitReady(g.org);
    const res = await reset(g.c, g.org);
    expect(res.error?.code).toBe("OD403");
    expect(res.error?.details).toBe("DEMO_EXPIRED");
    const anon = await reset(client(), g.org);
    expect(anon.error).not.toBeNull();
  });
});
