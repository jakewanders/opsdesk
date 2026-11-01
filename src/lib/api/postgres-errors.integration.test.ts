import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";
import { mapPostgresError } from "./postgres-errors";

// Real errors from the local Postgres and PostgREST, run through the mapper. This proves the
// mapping matches the actual error shape, not just hand-written fixtures.

let local: LocalSupabase;
let admin: ReturnType<typeof createClient<Database>>;

/** `od_probe` is a throwaway function created by this test, so it is not in the generated types. */
type DbError = { code?: string; message?: string; details?: string; hint?: string } | null;
const probe = (kind: string): Promise<{ error: DbError }> =>
  (admin as unknown as { rpc(fn: string, args: object): Promise<{ error: DbError }> }).rpc(
    "od_probe",
    { kind },
  );
const userIds: string[] = [];

const LEAK =
  /profiles_pkey|profiles_id_fkey|profiles_display_name_length|duplicate key|violates|Key \(|relation "/;

function expectSafe(error: unknown, status: number, code: string) {
  const mapped = mapPostgresError(error);
  expect(mapped, JSON.stringify(error)).not.toBeNull();
  expect(mapped?.status).toBe(status);
  expect(mapped?.code).toBe(code);
  expect(JSON.stringify({ m: mapped?.message, f: mapped?.fieldErrors })).not.toMatch(LEAK);
}

async function makeUser(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `api-errors-${crypto.randomUUID()}@example.com`,
    email_confirm: true,
  });
  expect(error).toBeNull();
  userIds.push(data.user!.id);
  return data.user!.id;
}

beforeAll(() => {
  local = localSupabase();
  admin = createClient<Database>(local.apiUrl, local.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  psql(`create or replace function public.od_probe(kind text) returns void language plpgsql as $$
    begin
      if kind = 'quota' then
        raise exception using errcode = 'OD429', message = 'Demo limit reached: customers.', detail = 'DEMO_QUOTA', hint = 'retry-after=60';
      elsif kind = 'expired' then
        raise exception using errcode = 'OD403', message = 'This demo has expired.', detail = 'DEMO_EXPIRED';
      else
        raise exception 'internal detail about secret_table';
      end if;
    end $$;`);
  psql("notify pgrst, 'reload schema'");
});

afterAll(() => {
  psql("drop function if exists public.od_probe(text)");
  for (const id of userIds) psql(`delete from auth.users where id = '${id}'`);
});

describe("mapPostgresError against real database errors", () => {
  it("23505 unique violation (duplicate primary key) is a 409 DUPLICATE", async () => {
    const id = await makeUser();
    const { error } = await admin.from("profiles").insert({ id, display_name: "Dup" });
    expect(error?.code).toBe("23505");
    expectSafe(error, 409, "DUPLICATE");
  });

  it("23503 foreign key violation is a 422 INVALID_REFERENCE", async () => {
    const { error } = await admin
      .from("profiles")
      .insert({ id: crypto.randomUUID(), display_name: "Orphan" });
    expect(error?.code).toBe("23503");
    expectSafe(error, 422, "INVALID_REFERENCE");
  });

  it("23514 check violation is a 422 CHECK_VIOLATION", async () => {
    const id = await makeUser();
    const { error } = await admin.from("profiles").update({ display_name: "" }).eq("id", id);
    expect(error?.code).toBe("23514");
    expectSafe(error, 422, "CHECK_VIOLATION");
  });

  it("22P02 malformed uuid is a 400", async () => {
    const { error } = await admin.from("profiles").select("id").eq("id", "not-a-uuid");
    expect(error?.code).toBe("22P02");
    expectSafe(error, 400, "BAD_REQUEST");
  });

  it("42501 permission denied (no insert grant for a signed-in user) is a 403", async () => {
    const id = await makeUser();
    const signIn = createClient(local.apiUrl, local.publishableKey, {
      auth: { persistSession: false },
    });
    const { data: link } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: (await admin.auth.admin.getUserById(id)).data.user!.email!,
    });
    expect(link?.properties?.hashed_token).toBeTruthy();
    const { data: verified } = await signIn.auth.verifyOtp({
      type: "magiclink",
      token_hash: link!.properties!.hashed_token,
    });
    expect(verified.session).not.toBeNull();
    const asUser = createClient(local.apiUrl, local.publishableKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${verified.session!.access_token}` } },
    });
    const { error } = await asUser.from("profiles").insert({ id, display_name: "Self" });
    expect(error?.code).toBe("42501");
    expectSafe(error, 403, "FORBIDDEN");
  });

  it("PGRST116 (no row for .single()) is a 404", async () => {
    const { error } = await admin
      .from("profiles")
      .select("id")
      .eq("id", crypto.randomUUID())
      .single();
    expect(error?.code).toBe("PGRST116");
    expectSafe(error, 404, "NOT_FOUND");
  });

  it("a custom OD429 raised in SQL keeps its authored message, machine code, and Retry-After", async () => {
    const { error } = await probe("quota");
    expect(error?.code).toBe("OD429");
    const mapped = mapPostgresError(error);
    expect(mapped?.status).toBe(429);
    expect(mapped?.code).toBe("DEMO_QUOTA");
    expect(mapped?.message).toBe("Demo limit reached: customers.");
    expect(mapped?.headers).toEqual({ "Retry-After": "60" });
  });

  it("a custom OD403 raised in SQL is a 403 with the machine code", async () => {
    const { error } = await probe("expired");
    const mapped = mapPostgresError(error);
    expect(mapped?.status).toBe(403);
    expect(mapped?.code).toBe("DEMO_EXPIRED");
  });

  it("a plain RAISE EXCEPTION (P0001) is NOT mapped, so its text can never be shown", async () => {
    const { error } = await probe("other");
    expect(error?.code).toBe("P0001");
    expect(error?.message).toContain("secret_table");
    expect(mapPostgresError(error)).toBeNull();
  });
});
