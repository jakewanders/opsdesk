import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorResponse } from "@/lib/api/envelope";
import { toApiError } from "@/lib/api/to-api-error";
import { withDockerPath } from "../../../scripts/lib/docker-path.mjs";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";

/**
 * The demo cap through PostgREST with a real guest and a real member: the database error reaches the API error
 * mapper as a 429 in the standard envelope. A probe table stands in for an entity table (customers arrive in M2).
 */
const run = Date.now();
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
let supabase: LocalSupabase;
const userIds: string[] = [];
let guestOrg = "";
let realOrg = "";

const client = () =>
  createClient(supabase.apiUrl, supabase.publishableKey, { auth: { persistSession: false } });

beforeAll(async () => {
  supabase = localSupabase();
  psql(`
    create table public.zz_cap_probe (id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, name text not null);
    create index on public.zz_cap_probe (organization_id);
    grant select, insert on public.zz_cap_probe to authenticated;
    alter table public.zz_cap_probe enable row level security;
    create policy zz_probe on public.zz_cap_probe for all to authenticated using (private.is_member(organization_id)) with check (private.is_member(organization_id));
    insert into private.app_limits (key, value, note) values ('demo_cap_zz_probe', 2, 'integration probe');
    select private.attach_demo_cap('public.zz_cap_probe', 'demo_cap_zz_probe');
    notify pgrst, 'reload schema';
  `);
  await new Promise((r) => setTimeout(r, 1500));
});

afterAll(() => {
  psql(
    `drop table if exists public.zz_cap_probe; delete from private.app_limits where key = 'demo_cap_zz_probe'`,
  );
  if (userIds.length) {
    const list = userIds.map((i) => `'${i}'`).join(",");
    psql(`delete from public.organizations where created_by in (${list})`);
    psql(`delete from auth.users where id in (${list})`);
  }
  psql(`notify pgrst, 'reload schema'`);
});

describe("demo cap over the API", () => {
  it("a guest hits the cap and the error maps to a 429 envelope", async () => {
    const g = client();
    const { data, error } = await g.auth.signInAnonymously({ options: { captchaToken: TOKEN } });
    expect(error).toBeNull();
    userIds.push(data.user!.id);
    const boot = await g.rpc("bootstrap_demo_workspace");
    guestOrg = (boot.data as { organization_id: string }).organization_id;

    for (const n of [1, 2]) {
      const ok = await g
        .from("zz_cap_probe")
        .insert({ organization_id: guestOrg, name: `row ${n}` });
      expect(ok.error, JSON.stringify(ok.error)).toBeNull();
    }
    const refused = await g
      .from("zz_cap_probe")
      .insert({ organization_id: guestOrg, name: "row 3" });
    expect(refused.error?.code).toBe("OD429");
    expect(refused.error?.details).toBe("DEMO_CAP");

    // exactly what withApi does with a thrown PostgREST error
    const { apiError } = toApiError(refused.error);
    const response = errorResponse(apiError, "req-test");
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.code).toBe("DEMO_CAP");
    expect(body.error.message).toBe(
      "Demo limit reached for zz cap probe. Reset the demo to start over.",
    );
    expect(body.error.requestId).toBe("req-test");
    expect(response.headers.get("retry-after")).toBe("60");
    expect(
      Number(
        psql(`select count(*) from public.zz_cap_probe where organization_id = '${guestOrg}'`),
      ),
    ).toBe(2);
  });

  it("RACE: an insert queues behind another session holding the workspace's cap lock", async () => {
    const holder = spawn(
      "docker",
      [
        "exec",
        "supabase_db_opsdesk",
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-c",
        `begin; select pg_advisory_xact_lock(hashtextextended('opsdesk.demo.cap:${guestOrg}:' || 'public.zz_cap_probe'::regclass::oid::text, 0)); select pg_sleep(3); commit;`,
      ],
      { env: withDockerPath() as NodeJS.ProcessEnv, stdio: "ignore" },
    );
    await new Promise((r) => setTimeout(r, 1000));
    // a fresh guest session on the same workspace id is not possible, so use the server role to insert as the owner would
    const started = Date.now();
    const res = await fetch(`${supabase.apiUrl}/rest/v1/zz_cap_probe`, {
      method: "POST",
      headers: {
        apikey: supabase.secretKey,
        Authorization: `Bearer ${supabase.secretKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ organization_id: guestOrg, name: "queued" }),
    });
    const waited = Date.now() - started;
    holder.kill();
    expect(waited, "should have queued behind the lock").toBeGreaterThan(1500);
    // the guest is already at the cap (2 rows), so the queued insert is then refused, not stored
    expect((await res.json()).code).toBe("OD429");
  });

  it("a real organization is unaffected by the same cap", async () => {
    const email = `cap-${run}@example.test`;
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
    realOrg = (
      await m.rpc("create_real_organization", {
        org_name: "Real Co",
        org_industry: null,
        org_timezone: "UTC",
      })
    ).data as string;
    const rows = Array.from({ length: 6 }, (_, i) => ({
      organization_id: realOrg,
      name: `real ${i}`,
    }));
    const res = await m.from("zz_cap_probe").insert(rows);
    expect(res.error).toBeNull();
    expect(
      Number(psql(`select count(*) from public.zz_cap_probe where organization_id = '${realOrg}'`)),
    ).toBe(6);
  });
});
