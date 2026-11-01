import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";
import { resolveWorkspaceState } from "./workspace-state";

/**
 * The routing query against the real schema and the real tenancy policies (SIT-194): a signed-in
 * user reads their own memberships and organizations through RLS.
 */
const run = Date.now();
const PASSWORD = "correct horse battery";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
let supabase: LocalSupabase;
const users: Record<string, { id: string; client: SupabaseClient }> = {};

async function signedInClient(label: string) {
  const email = `route-it-${run}-${label}@example.test`;
  const admin = await fetch(`${supabase.apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: supabase.secretKey,
      Authorization: `Bearer ${supabase.secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const { id } = (await admin.json()) as { id: string };
  const client = createClient(supabase.apiUrl, supabase.publishableKey, {
    auth: { persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email,
    password: PASSWORD,
    options: { captchaToken: TOKEN },
  });
  expect(error).toBeNull();
  return { id, client };
}

beforeAll(async () => {
  supabase = localSupabase();
  for (const label of ["none", "real", "live", "dead"]) users[label] = await signedInClient(label);
  const org = (id: string, kind: string, expires: string) =>
    `insert into public.organizations (id, name, kind, expires_at) values ('${id}', 'Route IT ${kind}', '${kind}', ${expires})`;
  const live = "e1000000-0000-0000-0000-0000000000a1";
  const dead = "e1000000-0000-0000-0000-0000000000a2";
  const real = "e1000000-0000-0000-0000-0000000000a3";
  psql(`${org(real, "real", "null")}; ${org(live, "demo", "now() + interval '1 day'")}; ${org(dead, "demo", "now() + interval '1 day'")};
    update public.organizations set expires_at = now() - interval '1 minute' where id = '${dead}';
    insert into public.memberships (organization_id, user_id, role) values
      ('${real}', '${users.real.id}', 'owner'), ('${live}', '${users.live.id}', 'owner'), ('${dead}', '${users.dead.id}', 'owner');`);
});

afterAll(() => {
  psql(
    `delete from public.organizations where id::text like 'e1000000-0000-0000-0000-0000000000a%'`,
  );
  psql(`delete from auth.users where email like 'route-it-${run}-%'`);
});

describe("resolveWorkspaceState against the local database", () => {
  it("none: a user with no membership", async () => {
    expect(await resolveWorkspaceState(users.none.client, users.none.id)).toBe("none");
  });
  it("ready: a real organization", async () => {
    expect(await resolveWorkspaceState(users.real.client, users.real.id)).toBe("ready");
  });
  it("ready: a demo that has not expired", async () => {
    expect(await resolveWorkspaceState(users.live.client, users.live.id)).toBe("ready");
  });
  it("expired-demo: only an expired demo", async () => {
    expect(await resolveWorkspaceState(users.dead.client, users.dead.id)).toBe("expired-demo");
  });
});

describe("when the query is refused", () => {
  it("a refused query is unknown, so routing never redirects on it", async () => {
    psql(`revoke select on public.memberships, public.organizations from authenticated`);
    try {
      expect(await resolveWorkspaceState(users.real.client, users.real.id)).toBe("unknown");
    } finally {
      psql(`grant select on public.memberships, public.organizations to authenticated`);
    }
  });
});
