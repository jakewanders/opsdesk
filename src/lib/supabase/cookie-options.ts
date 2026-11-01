import type { CookieOptions } from "@supabase/ssr";
import { getAppOrigin } from "@/lib/env/links";

/** Auth cookie lifetime: Supabase's default of 400 days (the longest browsers allow). */
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/**
 * Options for the Supabase auth cookies (PRD 10.2 item 10).
 *
 * - Host-scoped: no `domain`, so the cookie is never sent to sitelaunch.dev or other
 *   subdomains.
 * - `Secure` whenever the app's origin is https (production). It is off only for
 *   http://localhost so local development works in every browser.
 * - `SameSite=Lax`: sent on top-level navigations (email links, the auth callback) but not on
 *   cross-site subrequests.
 * - Not `HttpOnly`: the browser client signs in anonymously and refreshes tokens, so it must
 *   read the session. The tradeoff is recorded in docs/ARCHITECTURE.md. Server-side checks
 *   never trust the cookie payload; they verify it with Auth (`getUser`).
 */
export function authCookieOptions(origin: URL = getAppOrigin()): CookieOptions {
  return {
    path: "/",
    sameSite: "lax",
    secure: origin.protocol === "https:",
    httpOnly: false,
    maxAge: MAX_AGE_SECONDS,
  };
}
