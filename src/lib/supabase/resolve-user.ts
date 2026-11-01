import type { SupabaseClient } from "@supabase/supabase-js";

export type CurrentUser = {
  id: string;
  email: string | null;
  /** True for demo guests: Supabase anonymous sign-in users. */
  isAnonymous: boolean;
};

/**
 * Asks Supabase Auth who the caller is. `getUser` makes a request to the Auth server, which
 * checks the token's signature, expiry, and that the user still exists, so a forged,
 * tampered, or expired token yields `null`. The cookie payload is never trusted on its own
 * (`getSession` alone would). Pass `jwt` to verify a specific access token instead of the
 * client's own session.
 *
 * Never throws: an unreachable Auth service also yields `null`, which callers treat as signed out.
 */
export async function resolveUser(
  supabase: SupabaseClient<any, any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any -- generic over any Database
  jwt?: string,
): Promise<CurrentUser | null> {
  try {
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data.user) return null;
    return {
      id: data.user.id,
      email: data.user.email || null, // anonymous users have an empty string
      isAnonymous: data.user.is_anonymous === true,
    };
  } catch {
    return null;
  }
}
