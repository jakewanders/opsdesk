import { createBrowserClient } from "@supabase/ssr";
import { authCookieOptions } from "./cookie-options";
import type { Database } from "./database.types";

/**
 * Supabase client for Client Components. Uses the publishable key only; every query still
 * goes through RLS. Safe to call repeatedly: `createBrowserClient` returns a singleton in the
 * browser.
 *
 * The two values are read literally (Next.js inlines `process.env.NEXT_PUBLIC_*` only for direct reads) and NOT
 * through `getPublicEnv()`: that module also describes the server-only variables, and importing it from client
 * code would put their names in the browser bundle (`npm run check:bundle` fails on that). The server validates
 * the full set at startup, so a missing value here means a broken build.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    throw new Error("The Supabase public configuration is missing from this build.");
  return createBrowserClient<Database>(url, key, { cookieOptions: authCookieOptions() });
}
