import { spawn } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withDockerPath } from "../../../scripts/lib/docker-path.mjs";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";

/** create_real_organization() through PostgREST with real sessions: limit under a race, rejection, visibility. */
const run = Date.now();
const PASSWORD = "correct horse battery";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
let supabase: LocalSupabase;
const userIds: string[] = [];

async function member(label: string) {
  const email = `neworg-${run}-${label}@example.test`;
  const created = await fetch(`${supabase.apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: supabase.secretKey,
      Authorization: `Bearer ${supabase.secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const { id } = (await created.json()) as { id: string };
  userIds.push(id);
  const c = createClient(supabase.apiUrl, supabase.publishableKey, {
    auth: { persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({
    email,
    password: PASSWORD,
    options: { captchaToken: TOKEN },
  });
  expect(error).toBeNull();
  return { c, id };
}
const create = (c: SupabaseClient, name: string, industry?: string, tz?: string) =>
  c.rpc("create_real_organization", {
    org_name: name,
    org_industry: industry ?? null,
    org_timezone: tz ?? "UTC",
  });

beforeAll(() => {
  supabase = localSupabase();
});
afterAll(() => {
  if (userIds.length) {
    const list = userIds.map((i) => `'${i}'`).join(",");
    psql(`delete from public.organizations where created_by in (${list})`);
    psql(`delete from auth.users where id in (${list})`);
  }
  psql(`update private.app_limits set value = 5 where key = 'max_real_orgs_per_user'`);
});

describe("create_real_organization over the API", () => {
  it("creates an organization and owner membership, visible only to the creator", async () => {
    const u = await member("one");
    const other = await member("two");
    const res = await create(u.c, "Acme Plumbing", "Plumbing", "America/Chicago");
    expect(res.error).toBeNull();
    const orgId = res.data as string;
    const rows = await u.c.from("organizations").select("id, name, kind, expires_at, timezone");
    expect(rows.data).toEqual([
      {
        id: orgId,
        name: "Acme Plumbing",
        kind: "real",
        expires_at: null,
        timezone: "America/Chicago",
      },
    ]);
    const mine = await u.c.from("memberships").select("user_id, role").eq("organization_id", orgId);
    expect(mine.data).toEqual([{ user_id: u.id, role: "owner" }]);
    expect((await other.c.from("organizations").select("id").eq("id", orgId)).data).toEqual([]);
  });

  it("rejects an anonymous guest with 403-mapped OD403 and creates nothing", async () => {
    const g = createClient(supabase.apiUrl, supabase.publishableKey, {
      auth: { persistSession: false },
    });
    const { data, error } = await g.auth.signInAnonymously({ options: { captchaToken: TOKEN } });
    expect(error).toBeNull();
    userIds.push(data.user!.id);
    const res = await create(g, "Guest Co");
    expect(res.error?.code).toBe("OD403");
    expect(res.error?.message).toContain("Create an account");
    expect(
      Number(
        psql(`select count(*) from public.organizations where created_by = '${data.user!.id}'`),
      ),
    ).toBe(0);
  });

  it("maps validation failures to OD422 and rejects owner or id parameters", async () => {
    const u = await member("val");
    expect((await create(u.c, "A")).error?.code).toBe("OD422");
    expect((await create(u.c, "Acme", undefined, "Mars/Base")).error?.code).toBe("OD422");
    const injected = await u.c.rpc("create_real_organization", {
      org_name: "Acme",
      owner_id: u.id,
      organization_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(injected.error).not.toBeNull();
    expect(
      Number(psql(`select count(*) from public.organizations where created_by = '${u.id}'`)),
    ).toBe(0);
  });

  it("RACE: twelve simultaneous creations by one user stop exactly at the limit", async () => {
    const u = await member("race");
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => create(u.c, `Race Co ${i}`)),
    );
    const ok = results.filter((r) => r.error === null).length;
    const limited = results.filter((r) => r.error?.code === "OD429").length;
    expect(ok).toBe(5);
    expect(limited).toBe(7);
    expect(
      Number(psql(`select count(*) from public.organizations where created_by = '${u.id}'`)),
    ).toBe(5);
    expect(
      Number(
        psql(
          `select count(*) from public.memberships where user_id = '${u.id}' and role = 'owner'`,
        ),
      ),
    ).toBe(5);
  });

  it("RACE: a call waits while another session holds that user's lock", async () => {
    const u = await member("lock");
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
        `begin; select pg_advisory_xact_lock(hashtextextended('opsdesk.org.create:${u.id}', 0)); select pg_sleep(3); commit;`,
      ],
      { env: withDockerPath() as NodeJS.ProcessEnv, stdio: "ignore" },
    );
    await new Promise((r) => setTimeout(r, 1000));
    const started = Date.now();
    const res = await create(u.c, "Queued Co");
    const waited = Date.now() - started;
    holder.kill();
    expect(res.error).toBeNull();
    expect(waited, "should have queued behind the lock").toBeGreaterThan(1500);
  });
});
