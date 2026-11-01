import { createBrowserClient } from "@supabase/ssr";
import { getPublicEnv } from "@/lib/env/public";
import { authCookieOptions } from "./cookie-options";
import type { Database } from "./database.types";

/**
 * Supabase client for Client Components. Uses the publishable key only; every query still
 * goes through RLS. Safe to call repeatedly: `createBrowserClient` returns a singleton in the
 * browser.
 */
export function createClient() {
  const env = getPublicEnv();
  return createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { cookieOptions: authCookieOptions() },
  );
}
