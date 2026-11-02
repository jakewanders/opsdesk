import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/**
 * POST /api/v1/demo/reset against the production build and the local stack. A scratch entity with a registered seeder
 * stands in for the CRM tables (they arrive in M2): the guest edits and deletes its rows, and reset puts them back.
 */
const server = new RealServer();
const BOOT = "/api/v1/demo/bootstrap";
const RESET = "/api/v1/demo/reset";
const run = Date.now();
const table = `zz_reset_${run}`;
const seeder = `zz_reset_${run}`;

function sdk(actor: Actor): SupabaseClient {
  const token = JSON.parse(Buffer.from(actor.cookie.split("=base64-")[1], "base64url").toString())
    .access_token as string;
  return createClient(server.supabase.apiUrl, server.supabase.publishableKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

beforeAll(async () => {
  psql(`
    create table public.${table} (id uuid primary key default gen_random_uuid(),
      organization_id uuid not null references public.organizations (id) on delete cascade, name text not null);
    alter table public.${table} enable row level security;
    create policy member on public.${table} for all to authenticated
      using (private.is_member(organization_id)) with check (private.is_member(organization_id));
    grant select, insert, update, delete on public.${table} to authenticated;
    create function private.${seeder}_seed(org uuid) returns void language plpgsql as $f$
      begin insert into public.${table} (organization_id, name) values (org, 'Acme Plumbing'), (org, 'Riverbend Roofing'); end $f$;
    create function private.${seeder}_clear(org uuid) returns void language plpgsql as $f$
      begin delete from public.${table} where organization_id = org; end $f$;
    select private.register_demo_seeder('${seeder}', 900, 'private.${seeder}_seed(uuid)'::regprocedure, 1,
      'private.${seeder}_clear(uuid)'::regprocedure);
    notify pgrst, 'reload schema';
  `);
  await server.start();
  await new Promise((r) => setTimeout(r, 1500));
}, 400_000);

afterAll(() => {
  server.stop();
  // unregister before dropping what it points at, so no other bootstrap can hit a dangling seeder
  psql(`delete from private.demo_seeders where name = '${seeder}'`);
  psql(
    `drop table if exists public.${table}; drop function if exists private.${seeder}_seed(uuid), private.${seeder}_clear(uuid)`,
  );
});

const names = (org: string) =>
  psql(
    `select coalesce(string_agg(name, ',' order by name), '') from public.${table} where organization_id = '${org}'`,
  );

async function guestWithDemo() {
  const guest = await server.guest();
  const res = await server.request(BOOT, guest, { method: "POST" });
  expect(res.status).toBe(200);
  return { guest, org: (await res.json()).data.organizationId as string, sb: sdk(guest) };
}

describe("POST /api/v1/demo/reset", () => {
  it("restores the seed state: edits and deletions are undone, the expiry is unchanged", async () => {
    const { guest, org, sb } = await guestWithDemo();
    expect(names(org)).toBe("Acme Plumbing,Riverbend Roofing");
    await sb.from(table).update({ name: "Edited" }).eq("organization_id", org);
    await sb.from(table).insert({ organization_id: org, name: "Mine" });
    expect(names(org)).toBe("Edited,Edited,Mine");
    const before = psql(`select expires_at from public.organizations where id = '${org}'`);

    const res = await server.request(RESET, guest, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body.data).toMatchObject({ organizationId: org });
    expect(names(org)).toBe("Acme Plumbing,Riverbend Roofing");
    expect(psql(`select expires_at from public.organizations where id = '${org}'`)).toBe(before);
    expect(new Date(body.data.resetAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("spamming it gives the throttle message and Retry-After, never an error page, and changes nothing", async () => {
    const { guest, org, sb } = await guestWithDemo();
    expect((await server.request(RESET, guest, { method: "POST" })).status).toBe(200);
    await sb.from(table).insert({ organization_id: org, name: "After first reset" });
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 5; i++) {
      last = await server.request(RESET, guest, { method: "POST" });
      statuses.push(last.status);
    }
    expect(statuses).toEqual([429, 429, 429, 429, 429]);
    const body = await last!.json();
    expect(body.error.code).toBe("DEMO_RESET_THROTTLED");
    expect(body.error.message).toMatch(/once a minute\. Try again in \d+ seconds?\./);
    const retry = Number(last!.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    expect(names(org)).toContain("After first reset"); // the throttled calls did not reset
  });

  it("an idempotency key replays the stored answer instead of resetting again", async () => {
    const { guest, org, sb } = await guestWithDemo();
    const headers = { "Idempotency-Key": `reset-${run}-aaaa1111` };
    const first = await (await server.request(RESET, guest, { method: "POST", headers })).json();
    await sb.from(table).insert({ organization_id: org, name: "After reset" });
    const replay = await server.request(RESET, guest, { method: "POST", headers });
    expect(replay.status).toBe(200); // not 429: it is the same request
    expect((await replay.json()).data).toEqual(first.data);
    expect(names(org)).toContain("After reset");
  });

  it("a registered user gets 403 and nothing changes", async () => {
    const member = await server.member("reset");
    const res = await server.request(RESET, member, { method: "POST" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("GUEST_ONLY");
  });

  it("a guest who never started a demo gets 404; signed out gets 401; a foreign origin 403; GET 405", async () => {
    const guest = await server.guest();
    const none = await server.request(RESET, guest, { method: "POST" });
    expect(none.status).toBe(404);
    expect((await none.json()).error.code).toBe("DEMO_NOT_FOUND");
    expect((await server.request(RESET, null, { method: "POST" })).status).toBe(401);
    const { guest: g2 } = await guestWithDemo();
    expect(
      (
        await server.request(RESET, g2, {
          method: "POST",
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect((await server.request(RESET, g2, { method: "GET" })).status).toBe(405);
  });

  it("cannot reset another guest's demo: there is no way to name it, and each reset only touches the caller's own", async () => {
    const a = await guestWithDemo();
    const b = await guestWithDemo();
    await b.sb.from(table).update({ name: "B edited" }).eq("organization_id", b.org);
    expect(
      (await server.request(RESET, a.guest, { method: "POST", json: { organizationId: b.org } }))
        .status,
    ).toBe(200);
    expect(names(b.org)).toBe("B edited,B edited"); // B untouched
    expect(names(a.org)).toBe("Acme Plumbing,Riverbend Roofing");
  });
});
