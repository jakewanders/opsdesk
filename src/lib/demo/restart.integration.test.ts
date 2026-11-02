import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";
import { restartDemo } from "./restart";

/** The restart flow with a real guest whose demo expired: a fresh, seeded demo, the old one gone. */
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
let supabase: LocalSupabase;
const userIds: string[] = [];

beforeAll(() => {
  supabase = localSupabase();
});
afterAll(() => {
  if (userIds.length) {
    const list = userIds.map((i) => `'${i}'`).join(",");
    psql(`delete from public.organizations where created_by in (${list})`);
    psql(`delete from auth.users where id in (${list})`);
  }
});

describe("restartDemo against local Supabase", () => {
  it("replaces an expired demo with a fresh one for the same guest", async () => {
    const c = createClient(supabase.apiUrl, supabase.publishableKey, {
      auth: { persistSession: false },
    });
    const { data, error } = await c.auth.signInAnonymously({ options: { captchaToken: TOKEN } });
    expect(error).toBeNull();
    const id = data.user!.id;
    userIds.push(id);
    const first = (await c.rpc("bootstrap_demo_workspace")).data as { organization_id: string };

    // the clock passes expires_at (the trusted test hook: set_demo_expiry / a direct update as postgres)
    psql(
      `update public.organizations set expires_at = now() - interval '1 minute' where id = '${first.organization_id}'`,
    );
    const before = await c.from("organizations").select("id, expires_at");
    expect(new Date(before.data![0].expires_at).getTime()).toBeLessThan(Date.now());

    const result = await restartDemo(c);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.organizationId).not.toBe(first.organization_id);

    const after = await c.from("organizations").select("id, kind, expires_at");
    expect(after.data).toHaveLength(1);
    expect(after.data![0]).toMatchObject({ id: result.organizationId, kind: "demo" });
    expect(new Date(after.data![0].expires_at).getTime()).toBeGreaterThan(
      Date.now() + 23 * 3600_000,
    );
    expect(
      Number(
        psql(`select count(*) from public.organizations where id = '${first.organization_id}'`),
      ),
    ).toBe(0);
    expect(
      Number(psql(`select count(*) from public.organizations where created_by = '${id}'`)),
    ).toBe(1);
  });

  it("a registered user cannot use it to get a demo", async () => {
    const email = `restart-${Date.now()}@example.test`;
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
    const c = createClient(supabase.apiUrl, supabase.publishableKey, {
      auth: { persistSession: false },
    });
    await c.auth.signInWithPassword({
      email,
      password: "correct horse battery",
      options: { captchaToken: TOKEN },
    });
    expect(await restartDemo(c)).toMatchObject({ ok: false, reason: "not_guest" });
    expect(
      Number(psql(`select count(*) from public.organizations where created_by = '${id}'`)),
    ).toBe(0);
  });
});
