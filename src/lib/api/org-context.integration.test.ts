import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";
import { ORG_HEADER, resolveOrg } from "./org-context";

/**
 * resolveOrg against the real database and real tenancy RLS, with real signed-in sessions:
 * cross-tenant header, non-member, multi-org, expired demo (PRD 11.3).
 */
const run = Date.now();
const PASSWORD = "correct horse battery";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const ORG_A = "e5000000-0000-0000-0000-0000000000a1";
const ORG_B = "e5000000-0000-0000-0000-0000000000b2";
const DEMO_LIVE = "e5000000-0000-0000-0000-0000000000d1";
const DEMO_DEAD = "e5000000-0000-0000-0000-0000000000d2";

let supabase: LocalSupabase;
type Actor = {
  id: string;
  client: SupabaseClient;
  user: { id: string; email: string | null; isAnonymous: boolean };
};
const actors: Record<string, Actor> = {};

async function makeUser(label: string): Promise<Actor> {
  const email = `orgctx-${run}-${label}@example.test`;
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
  const client = createClient(supabase.apiUrl, supabase.publishableKey, {
    auth: { persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email,
    password: PASSWORD,
    options: { captchaToken: TOKEN },
  });
  expect(error).toBeNull();
  return { id, client, user: { id, email, isAnonymous: false } };
}

const req = (header?: string) =>
  new Request("http://localhost/api/v1/x", { headers: header ? { [ORG_HEADER]: header } : {} });
const thrown = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { status: number; code: string; message: string };
  }
  throw new Error("expected a throw");
};

beforeAll(async () => {
  supabase = localSupabase();
  for (const label of ["a", "b", "multi", "none", "guest"]) actors[label] = await makeUser(label);
  psql(`
    insert into public.organizations (id, name) values ('${ORG_A}', 'Org A'), ('${ORG_B}', 'Org B');
    insert into public.organizations (id, name, kind, expires_at) values
      ('${DEMO_LIVE}', 'Live Demo', 'demo', now() + interval '1 hour'),
      ('${DEMO_DEAD}', 'Dead Demo', 'demo', now() + interval '1 hour');
    update public.organizations set expires_at = now() - interval '1 minute' where id = '${DEMO_DEAD}';
    insert into public.memberships (organization_id, user_id, role) values
      ('${ORG_A}', '${actors.a.id}', 'owner'),
      ('${ORG_B}', '${actors.b.id}', 'owner'),
      ('${ORG_A}', '${actors.multi.id}', 'viewer'),
      ('${ORG_B}', '${actors.multi.id}', 'admin'),
      ('${DEMO_LIVE}', '${actors.guest.id}', 'owner'),
      ('${DEMO_DEAD}', '${actors.guest.id}', 'owner');
  `);
});

afterAll(() => {
  psql(
    `delete from public.organizations where id::text like 'e5000000-0000-0000-0000-0000000000%'`,
  );
  psql(`delete from auth.users where email like 'orgctx-${run}-%'`);
});

describe("resolveOrg with real sessions and RLS", () => {
  it("a single membership defaults safely and the role comes from the database", async () => {
    const ctx = await resolveOrg(req(), actors.a.user, actors.a.client);
    expect(ctx).toMatchObject({ role: "owner", kind: "real", expired: false });
    expect(ctx.org.id).toBe(ORG_A);
    expect(ctx.org.name).toBe("Org A");
  });
  it("a forged header naming another tenant is a 404, identical to an unknown id", async () => {
    const forged = await thrown(resolveOrg(req(ORG_B), actors.a.user, actors.a.client));
    const unknown = await thrown(
      resolveOrg(req("99999999-9999-9999-9999-999999999999"), actors.a.user, actors.a.client),
    );
    expect(forged.status).toBe(404);
    expect(forged.code).toBe("ORG_NOT_FOUND");
    expect(unknown.message).toBe(forged.message);
  });
  it("lying about who you are does not help: the memberships read is under the caller's own session", async () => {
    // user B's client with user A's identity object: RLS returns only B's rows, so A's org is not found
    const e = await thrown(resolveOrg(req(ORG_A), actors.a.user, actors.b.client));
    expect(e.status).toBe(404);
  });
  it("a user with no membership gets NO_WORKSPACE, and a header changes nothing", async () => {
    expect((await thrown(resolveOrg(req(), actors.none.user, actors.none.client))).code).toBe(
      "NO_WORKSPACE",
    );
    expect((await thrown(resolveOrg(req(ORG_A), actors.none.user, actors.none.client))).code).toBe(
      "ORG_NOT_FOUND",
    );
  });
  it("several memberships need an explicit choice (422), and each choice gets its own role", async () => {
    const e = await thrown(resolveOrg(req(), actors.multi.user, actors.multi.client));
    expect(e.status).toBe(422);
    expect(e.code).toBe("ORG_SELECTION_REQUIRED");
    expect(await resolveOrg(req(ORG_A), actors.multi.user, actors.multi.client)).toMatchObject({
      role: "viewer",
    });
    expect(await resolveOrg(req(ORG_B), actors.multi.user, actors.multi.client)).toMatchObject({
      role: "admin",
    });
  });
  it("a live demo resolves; an expired one is DEMO_EXPIRED unless allowed", async () => {
    const live = await resolveOrg(req(DEMO_LIVE), actors.guest.user, actors.guest.client);
    expect(live).toMatchObject({ kind: "demo", expired: false, role: "owner" });
    const dead = await thrown(resolveOrg(req(DEMO_DEAD), actors.guest.user, actors.guest.client));
    expect(dead.status).toBe(403);
    expect(dead.code).toBe("DEMO_EXPIRED");
    const allowed = await resolveOrg(req(DEMO_DEAD), actors.guest.user, actors.guest.client, {
      allowExpired: true,
    });
    expect(allowed).toMatchObject({ kind: "demo", expired: true });
  });
  it("a malformed header is a 400 and never reaches the database", async () => {
    expect(
      (await thrown(resolveOrg(req("not-a-uuid"), actors.a.user, actors.a.client))).status,
    ).toBe(400);
  });
});
