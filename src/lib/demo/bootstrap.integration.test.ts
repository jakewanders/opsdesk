import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withDockerPath } from "../../../scripts/lib/docker-path.mjs";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";

/**
 * bootstrap_demo_workspace() through PostgREST with REAL anonymous sessions (local GoTrue + Turnstile dummy),
 * the same path the server route (SIT-204) will use. Proves the race, isolation and rejection behaviour
 * end to end, not just inside one SQL session.
 */
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
  return { c, id: data.user!.id };
}

type Result = {
  organization_id: string;
  expires_at: string;
  created: boolean;
  seed_version: number;
};
const bootstrap = async (c: SupabaseClient) => c.rpc("bootstrap_demo_workspace");

beforeAll(() => {
  supabase = localSupabase();
});
afterAll(() => {
  if (userIds.length) {
    const list = userIds.map((id) => `'${id}'`).join(",");
    psql(`delete from public.organizations where created_by in (${list})`);
    psql(`delete from auth.users where id in (${list})`);
  }
});

describe("bootstrap_demo_workspace over the API", () => {
  it("creates a demo for an anonymous guest and returns the same one on a repeat call", async () => {
    const g = await guest();
    const first = await bootstrap(g.c);
    expect(first.error).toBeNull();
    const a = first.data as Result;
    expect(a.created).toBe(true);
    const second = (await bootstrap(g.c)).data as Result;
    expect(second.created).toBe(false);
    expect(second.organization_id).toBe(a.organization_id);
    expect(second.expires_at).toBe(a.expires_at);
    expect(
      Number(psql(`select count(*) from public.organizations where created_by = '${g.id}'`)),
    ).toBe(1);
  });

  it("RACE: forty simultaneous calls for one guest produce exactly one organization", async () => {
    const g = await guest();
    const results = await Promise.all(Array.from({ length: 40 }, () => bootstrap(g.c)));
    for (const r of results) expect(r.error, JSON.stringify(r.error)).toBeNull();
    const ids = new Set(results.map((r) => (r.data as Result).organization_id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => (r.data as Result).created).length).toBe(1);
    expect(
      Number(psql(`select count(*) from public.organizations where created_by = '${g.id}'`)),
    ).toBe(1);
    expect(Number(psql(`select count(*) from public.memberships where user_id = '${g.id}'`))).toBe(
      1,
    );
    expect(
      Number(psql(`select count(*) from public.demo_workspaces where user_id = '${g.id}'`)),
    ).toBe(1);
  });

  it("RACE: a call waits while another session holds that user's lock, then returns the one organization", async () => {
    const g = await guest();
    // Another session (think: a second tab) is mid-bootstrap and holds the user's lock for 3 seconds.
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
        `begin; select pg_advisory_xact_lock(hashtextextended('opsdesk.demo.bootstrap:${g.id}', 0)); select pg_sleep(3); commit;`,
      ],
      { env: withDockerPath() as NodeJS.ProcessEnv, stdio: "ignore" },
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const started = Date.now();
    const result = await bootstrap(g.c);
    const waited = Date.now() - started;
    holder.kill();
    expect(result.error).toBeNull();
    expect(waited, "the call should have queued behind the lock").toBeGreaterThan(1500);
    expect((result.data as Result).created).toBe(true);
    expect(
      Number(psql(`select count(*) from public.organizations where created_by = '${g.id}'`)),
    ).toBe(1);
  });

  it("RACE: two guests bootstrapping together each get their own organization", async () => {
    const [x, y] = await Promise.all([guest(), guest()]);
    const [rx, ry] = await Promise.all([bootstrap(x.c), bootstrap(y.c)]);
    const a = rx.data as Result;
    const b = ry.data as Result;
    expect(a.organization_id).not.toBe(b.organization_id);
    // each only sees their own through RLS
    const seenByX = await x.c.from("organizations").select("id");
    expect(seenByX.data?.map((o) => o.id)).toEqual([a.organization_id]);
    const peek = await y.c.from("organizations").select("id").eq("id", a.organization_id);
    expect(peek.data).toEqual([]);
  });

  it("rejects a signed-in (non-anonymous) user and the anon key", async () => {
    const email = `boot-${Date.now()}@example.test`;
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
    try {
      const member = client();
      const signIn = await member.auth.signInWithPassword({
        email,
        password: "correct horse battery",
        options: { captchaToken: TOKEN },
      });
      expect(signIn.error).toBeNull();
      const res = await bootstrap(member);
      expect(res.error?.code).toBe("OD403");
      expect(res.error?.message).toBe("The live demo is for guest visitors. Sign out to try it.");
      expect(
        Number(psql(`select count(*) from public.organizations where created_by = '${id}'`)),
      ).toBe(0);
    } finally {
      psql(`delete from auth.users where id = '${id}'`);
    }
    const anon = await bootstrap(client());
    expect(anon.error).not.toBeNull();
    expect(["42501", "OD403"]).toContain(anon.error?.code);
  });

  it("a guest cannot pass identity arguments, and cannot extend their expiry through the API", async () => {
    const g = await guest();
    await bootstrap(g.c);
    const withArg = await g.c.rpc("bootstrap_demo_workspace", {
      owner_id: g.id,
      organization_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(withArg.error).not.toBeNull();
    const patch = await g.c
      .from("organizations")
      .update({ expires_at: "2099-01-01T00:00:00Z" })
      .eq("created_by", g.id)
      .select();
    expect(patch.error).not.toBeNull();
  });
});
