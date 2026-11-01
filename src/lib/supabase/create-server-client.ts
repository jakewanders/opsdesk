import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { getPublicEnv } from "@/lib/env/public";
import { authCookieOptions } from "./cookie-options";
import type { Database } from "./database.types";

/** What the server client needs from a cookie store (next/headers, a request, or a test jar). */
export type CookieJar = {
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options: CookieOptions): void;
};

/**
 * Builds a request-scoped Supabase client bound to `jar`. Create a new one per request;
 * never share a client between requests.
 *
 * `set` can throw when called from a Server Component (Next.js only allows cookie writes in
 * route handlers, server actions, and the proxy). That is expected: the proxy refreshes the
 * session before rendering, so the write is safe to drop here.
 */
export function createServerSupabase(
  jar: CookieJar,
  env: { url: string; key: string } = {
    url: getPublicEnv().NEXT_PUBLIC_SUPABASE_URL,
    key: getPublicEnv().NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  },
) {
  return createServerClient<Database>(env.url, env.key, {
    cookieOptions: authCookieOptions(),
    cookies: {
      getAll: () => jar.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) jar.set(name, value, options);
        } catch {
          // Called from a Server Component; the proxy owns session refresh.
        }
      },
    },
  });
}
