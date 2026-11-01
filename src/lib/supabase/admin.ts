import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getPublicEnv } from "@/lib/env/public";
import { requireSecret } from "@/lib/env/server";
import type { Database } from "./database.types";

/**
 * Privileged Supabase client using the secret key. It BYPASSES row level security.
 *
 * Allowed callers only (enforced by the `no-restricted-imports` rule in eslint.config.mjs):
 * demo cleanup, the demo bootstrap and reset route handlers, Netlify functions, and scripts.
 * Never use it for ordinary business reads or writes: those must run as the signed-in user so
 * RLS applies. `server-only` makes any import from client code a build error.
 */
export function createAdminClient() {
  return createClient<Database>(
    getPublicEnv().NEXT_PUBLIC_SUPABASE_URL,
    requireSecret("SUPABASE_SECRET_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    },
  );
}
