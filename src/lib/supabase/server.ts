import "server-only";
import { cookies } from "next/headers";
import { createServerSupabase } from "./create-server-client";

/**
 * Supabase client for Server Components, route handlers, and server actions. It acts as the
 * signed-in user (their session cookies), so every query runs under that user's RLS. Never use
 * it to bypass RLS; see `admin.ts` for the one narrow exception.
 */
export async function createClient() {
  const store = await cookies();
  return createServerSupabase({
    getAll: () => store.getAll(),
    set: (name, value, options) => store.set(name, value, options),
  });
}
