import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";
import { createWorkspace, isMemberOf, listWorkspaces } from "./workspace-core";

/** Workspace creation and membership checks with real sessions and RLS. */
const run = Date.now();
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
let supabase: LocalSupabase;
const ids: string[] = [];
const client = () =>
  createClient(supabase.apiUrl, supabase.publishableKey, { auth: { persistSession: false } });

async function member(label: string) {
  const email = `ws-${run}-${label}@example.test`;
  const made = await fetch(`${supabase.apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: supabase.secretKey,
      Authorization: `Bearer ${supabase.secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password: "correct horse battery", email_confirm: true }),
  });
  const { id } = (await made.json()) as { id: string };
  ids.push(id);
  const c = client();
  await c.auth.signInWithPassword({
    email,
    password: "correct horse battery",
    options: { captchaToken: TOKEN },
  });
  return { c, id };
}

beforeAll(() => {
  supabase = localSupabase();
});
afterAll(() => {
  if (ids.length) {
    const list = ids.map((i) => `'${i}'`).join(",");
    psql(`delete from public.organizations where created_by in (${list})`);
    psql(`delete from auth.users where id in (${list})`);
  }
});

describe("workspace creation and membership with real sessions", () => {
  it("a new member with no workspace creates one and then belongs to it", async () => {
    const u = await member("new");
    expect(await listWorkspaces(u.c, u.id)).toEqual([]);
    const r = await createWorkspace(
      u.c,
      { isAnonymous: false },
      { name: "Setup Co", industry: "Plumbing", timezone: "America/Denver" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [w] = await listWorkspaces(u.c, u.id);
    expect(w).toMatchObject({
      id: r.id,
      name: "Setup Co",
      kind: "real",
      role: "owner",
      timezone: "America/Denver",
    });
    expect(await isMemberOf(u.c, u.id, r.id)).toBe(true);
  });
  it("a foreign or tampered organization id is never a membership", async () => {
    const [a, b] = await Promise.all([member("a"), member("b")]);
    const ra = await createWorkspace(
      a.c,
      { isAnonymous: false },
      { name: "A Co", industry: "", timezone: "" },
    );
    const rb = await createWorkspace(
      b.c,
      { isAnonymous: false },
      { name: "B Co", industry: "", timezone: "" },
    );
    if (!ra.ok || !rb.ok) throw new Error("setup failed");
    expect(await isMemberOf(a.c, a.id, rb.id)).toBe(false);
    expect(await isMemberOf(b.c, b.id, ra.id)).toBe(false);
    expect(await isMemberOf(a.c, a.id, "99999999-9999-4999-8999-999999999999")).toBe(false);
    expect(await isMemberOf(a.c, a.id, "'; drop table organizations; --")).toBe(false);
    // even claiming to be user A with user B's session reveals nothing
    expect(await isMemberOf(b.c, a.id, ra.id)).toBe(false);
  });
  it("a user with two workspaces sees both, and only their own", async () => {
    const u = await member("multi");
    const other = await member("other");
    const one = await createWorkspace(
      u.c,
      { isAnonymous: false },
      { name: "First", industry: "", timezone: "" },
    );
    const two = await createWorkspace(
      u.c,
      { isAnonymous: false },
      { name: "Second", industry: "", timezone: "" },
    );
    const foreign = await createWorkspace(
      other.c,
      { isAnonymous: false },
      { name: "Foreign", industry: "", timezone: "" },
    );
    if (!one.ok || !two.ok || !foreign.ok) throw new Error("setup failed");
    const names = (await listWorkspaces(u.c, u.id)).map((w) => w.name);
    expect(names).toEqual(["First", "Second"]);
    expect(await isMemberOf(u.c, u.id, foreign.id)).toBe(false);
  });
  it("a guest cannot create a workspace (403 path), and the database agrees", async () => {
    const g = client();
    const { data } = await g.auth.signInAnonymously({ options: { captchaToken: TOKEN } });
    ids.push(data.user!.id);
    expect(
      await createWorkspace(
        g,
        { isAnonymous: true },
        { name: "Guest Co", industry: "", timezone: "" },
      ),
    ).toMatchObject({ ok: false, reason: "guest" });
    // even bypassing the helper, the database function refuses
    expect(
      (
        await g.rpc("create_real_organization", {
          org_name: "Guest Co",
          org_industry: null,
          org_timezone: "UTC",
        })
      ).error?.code,
    ).toBe("OD403");
    expect(
      Number(
        psql(`select count(*) from public.organizations where created_by = '${data.user!.id}'`),
      ),
    ).toBe(0);
  });
});
