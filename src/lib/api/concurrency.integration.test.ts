import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupExpiredDemos } from "@/lib/cleanup/cleanup";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";
import { StaleEditError, updateIfCurrent } from "./concurrency";
import { okItem, created } from "./envelope";
import { withIdempotency } from "./idempotency";

/**
 * Real database, real PostgREST, two real sessions: concurrent stale edits (one wins, one gets 409) and an
 * idempotency key that keeps side effects from repeating. A scratch table stands in for the CRM entities
 * (they arrive in M2) with the same trigger and RLS shape.
 */
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const run = Date.now();
const ver = `zz_ver_${run}`;
const upd = `zz_upd_${run}`;
const fx = `zz_fx_${run}`; // side-effect log for the idempotency tests
let supabase: LocalSupabase;
let admin: SupabaseClient;
const users: string[] = [];

async function session(): Promise<{ client: SupabaseClient; id: string }> {
  const client = createClient(supabase.apiUrl, supabase.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInAnonymously({ options: { captchaToken: TOKEN } });
  expect(error).toBeNull();
  users.push(data.user!.id);
  return { client, id: data.user!.id };
}

async function waitForTable(client: SupabaseClient, table: string) {
  for (let i = 0; i < 40; i++) {
    const { error } = await client.from(table).select("id").limit(1);
    if (!error) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`PostgREST never exposed ${table}`);
}

beforeAll(async () => {
  supabase = localSupabase();
  admin = createClient(supabase.apiUrl, supabase.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  psql(`
    create table public.${upd} (id uuid primary key default gen_random_uuid(), owner uuid not null default auth.uid(),
      name text not null, updated_at timestamptz not null default now());
    create trigger t before update on public.${upd} for each row execute function private.set_updated_at();
    create table public.${ver} (id uuid primary key default gen_random_uuid(), owner uuid not null default auth.uid(),
      name text not null, version integer not null default 1, updated_at timestamptz not null default now());
    create trigger t before update on public.${ver} for each row execute function private.bump_version();
    create table public.${fx} (id uuid primary key default gen_random_uuid(), owner uuid not null default auth.uid(), note text);
    alter table public.${upd} enable row level security;
    alter table public.${ver} enable row level security;
    alter table public.${fx} enable row level security;
    create policy own on public.${upd} for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
    create policy own on public.${ver} for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
    create policy own on public.${fx} for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
    grant select, insert, update on public.${upd}, public.${ver}, public.${fx} to authenticated;
    notify pgrst, 'reload schema';
  `);
  const probe = await session();
  for (const t of [upd, ver, fx]) await waitForTable(probe.client, t);
});

afterAll(() => {
  psql(`drop table if exists public.${upd}, public.${ver}, public.${fx}`);
  if (users.length) {
    psql(`delete from auth.users where id in (${users.map((u) => `'${u}'`).join(",")})`);
  }
});

async function insertRow(client: SupabaseClient, table: string, name: string) {
  const { data, error } = await client.from(table).insert({ name }).select("*").single();
  expect(error).toBeNull();
  return data as { id: string; name: string; updated_at: string; version?: number };
}

describe("optimistic concurrency against the real database", () => {
  it("two concurrent edits from the same starting point: one wins, the other gets 409 and the winner is preserved", async () => {
    const { client } = await session();
    const row = await insertRow(client, upd, "original");
    const edit = (name: string) =>
      updateIfCurrent(client, {
        table: upd,
        id: row.id,
        expected: { updatedAt: row.updated_at },
        patch: { name },
        columns: "id, name, updated_at",
      });
    const results = await Promise.allSettled([edit("from A"), edit("from B")]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(StaleEditError);
    const winner = (won[0] as PromiseFulfilledResult<{ name: string; updated_at: string }>).value;
    const { data } = await client.from(upd).select("name, updated_at").eq("id", row.id).single();
    expect(data?.name).toBe(winner.name); // the first edit is preserved, not overwritten
    expect((lost[0].reason as StaleEditError).current.updatedAt).toBe(data?.updated_at);
    expect(data?.updated_at).not.toBe(row.updated_at);
  });

  it("the stale editor can retry with the current timestamp and then succeeds", async () => {
    const { client } = await session();
    const row = await insertRow(client, upd, "v1");
    await updateIfCurrent(client, {
      table: upd,
      id: row.id,
      expected: { updatedAt: row.updated_at },
      patch: { name: "v2" },
    });
    const stale = updateIfCurrent(client, {
      table: upd,
      id: row.id,
      expected: { updatedAt: row.updated_at },
      patch: { name: "late" },
    });
    const err = await stale.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleEditError);
    const retried = await updateIfCurrent(client, {
      table: upd,
      id: row.id,
      expected: { updatedAt: (err as StaleEditError).current.updatedAt },
      patch: { name: "late" },
    });
    expect(retried.name).toBe("late");
  });

  it("version-based entities: concurrent edits conflict, the version increments by one, and the client cannot set it", async () => {
    const { client } = await session();
    const row = await insertRow(client, ver, "q");
    expect(row.version).toBe(1);
    const results = await Promise.allSettled([
      updateIfCurrent(client, {
        table: ver,
        id: row.id,
        expected: { version: 1 },
        patch: { name: "A", version: 50 },
      }),
      updateIfCurrent(client, {
        table: ver,
        id: row.id,
        expected: { version: 1 },
        patch: { name: "B", version: 60 },
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
    expect(lost.reason).toMatchObject({ code: "STALE_EDIT", current: { version: 2 } });
    const { data } = await client.from(ver).select("version").eq("id", row.id).single();
    expect(data?.version).toBe(2);
  });

  it("another user's record is a 404, the same as a record that does not exist", async () => {
    const a = await session();
    const b = await session();
    const row = await insertRow(a.client, upd, "mine");
    await expect(
      updateIfCurrent(b.client, {
        table: upd,
        id: row.id,
        expected: { updatedAt: row.updated_at },
        patch: { name: "stolen" },
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      updateIfCurrent(b.client, {
        table: upd,
        id: crypto.randomUUID(),
        expected: { updatedAt: row.updated_at },
        patch: {},
      }),
    ).rejects.toMatchObject({ status: 404 });
    const { data } = await a.client.from(upd).select("name").eq("id", row.id).single();
    expect(data?.name).toBe("mine");
  });
});

describe("idempotency keys against the real database", () => {
  const sideEffect = (client: SupabaseClient, note: string) => async () => {
    const { data } = await client.from(fx).insert({ note }).select("id").single();
    return created({ id: (data as { id: string }).id });
  };
  const count = (owner: string, note: string) =>
    Number(psql(`select count(*) from public.${fx} where owner = '${owner}' and note = '${note}'`));

  it("five simultaneous requests with one key repeat the side effect exactly once", async () => {
    const { client, id } = await session();
    const opts = { route: "POST /fx", key: `conc-${run}-aaaa`, payload: { note: "once" } };
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => withIdempotency(client, opts, sideEffect(client, "once"))),
    );
    expect(count(id, "once")).toBe(1);
    const ok = results.filter((r) => r.status === "fulfilled");
    const waited = results.filter(
      (r): r is PromiseRejectedResult =>
        r.status === "rejected" &&
        (r.reason as { code?: string }).code === "IDEMPOTENCY_IN_PROGRESS",
    );
    expect(ok.length + waited.length).toBe(5);
    expect(ok.length).toBeGreaterThanOrEqual(1);
  });

  it("a replay after completion returns the original result and adds no row", async () => {
    const { client, id } = await session();
    const opts = { route: "POST /fx", key: `replay-${run}-bbbb`, payload: { note: "r" } };
    const first = await withIdempotency(client, opts, sideEffect(client, "r"));
    const second = await withIdempotency(client, opts, sideEffect(client, "r"));
    const third = await withIdempotency(client, opts, sideEffect(client, "r"));
    expect(count(id, "r")).toBe(1);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(third.body).toEqual(first.body);
  });

  it("the same key with a different payload is refused and does nothing", async () => {
    const { client, id } = await session();
    const key = `reuse-${run}-cccc`;
    await withIdempotency(
      client,
      { route: "POST /fx", key, payload: { note: "p1" } },
      sideEffect(client, "p1"),
    );
    await expect(
      withIdempotency(
        client,
        { route: "POST /fx", key, payload: { note: "p2" } },
        sideEffect(client, "p2"),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(count(id, "p2")).toBe(0);
  });

  it("keys are per user: another user's identical key does its own work", async () => {
    const a = await session();
    const b = await session();
    const key = `peruser-${run}-dddd`;
    const opts = { route: "POST /fx", key, payload: { note: "u" } };
    await withIdempotency(a.client, opts, sideEffect(a.client, "u"));
    const other = await withIdempotency(b.client, opts, sideEffect(b.client, "u"));
    expect(count(a.id, "u")).toBe(1);
    expect(count(b.id, "u")).toBe(1);
    expect(other.status).toBe(201);
  });

  it("a failed attempt releases the key so the same key can be retried", async () => {
    const { client, id } = await session();
    const opts = { route: "POST /fx", key: `retry-${run}-eeee`, payload: { note: "f" } };
    await expect(
      withIdempotency(client, opts, async () => {
        throw new Error("transient");
      }),
    ).rejects.toThrow("transient");
    await withIdempotency(client, opts, sideEffect(client, "f"));
    expect(count(id, "f")).toBe(1);
  });

  it("the store is closed to the browser: no direct read, write or delete as a signed-in user", async () => {
    const { client } = await session();
    expect(
      (
        await client
          .schema("private" as never)
          .from("idempotency_keys")
          .select("*")
      ).error,
    ).not.toBeNull();
    expect((await client.from("idempotency_keys").select("*")).error).not.toBeNull();
    const anon = createClient(supabase.apiUrl, supabase.publishableKey, {
      auth: { persistSession: false },
    });
    const res = await anon.rpc("idempotency_begin", {
      p_route: "r",
      p_key: "key-12345678",
      p_hash: "hash-hash",
    });
    expect(res.error).not.toBeNull();
  });

  it("expired keys are removed by the cleanup job and current ones are kept", async () => {
    const { client, id } = await session();
    await withIdempotency(
      client,
      { route: "POST /fx", key: `keep-${run}-ffff`, payload: 1 },
      async () => okItem({}),
    );
    await withIdempotency(
      client,
      { route: "POST /fx", key: `gone-${run}-gggg`, payload: 1 },
      async () => okItem({}),
    );
    psql(
      `update private.idempotency_keys set expires_at = now() - interval '1 minute' where user_id = '${id}' and key = 'gone-${run}-gggg'`,
    );
    const result = await cleanupExpiredDemos(admin as never, { log: () => undefined });
    expect(result.expiredKeysPurged).toBeGreaterThanOrEqual(1);
    const left = psql(
      `select string_agg(key, ',') from private.idempotency_keys where user_id = '${id}'`,
    );
    expect(left).toBe(`keep-${run}-ffff`);
  });
});
