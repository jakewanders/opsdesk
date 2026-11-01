import { parseFeatureFlags, parsePublicEnv, type FeatureFlags, type PublicEnv } from "./schema";

let cached: PublicEnv | undefined;

/**
 * Validated public configuration. Safe in client and server code.
 * Each variable is referenced literally: Next.js inlines NEXT_PUBLIC_* only for
 * direct `process.env.NAME` reads, not for `process.env[name]` or spreads.
 */
export function getPublicEnv(): PublicEnv {
  cached ??= parsePublicEnv(
    {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
      NEXT_PUBLIC_GITHUB_REPO_URL: process.env.NEXT_PUBLIC_GITHUB_REPO_URL,
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
      NEXT_PUBLIC_ENABLE_QUOTES: process.env.NEXT_PUBLIC_ENABLE_QUOTES,
      NEXT_PUBLIC_ENABLE_CSV_IMPORT: process.env.NEXT_PUBLIC_ENABLE_CSV_IMPORT,
      NEXT_PUBLIC_ENABLE_BILLING: process.env.NEXT_PUBLIC_ENABLE_BILLING,
      NEXT_PUBLIC_ENABLE_EMAIL: process.env.NEXT_PUBLIC_ENABLE_EMAIL,
      NEXT_PUBLIC_ENABLE_AI: process.env.NEXT_PUBLIC_ENABLE_AI,
      NEXT_PUBLIC_ENABLE_INTEGRATIONS: process.env.NEXT_PUBLIC_ENABLE_INTEGRATIONS,
    },
    // CONTEXT is server-side only; it is undefined in the browser, where the check is skipped.
    typeof window === "undefined" ? process.env.CONTEXT : undefined,
  );
  return cached;
}

/**
 * Feature flags only. They need none of the Supabase variables, so reading them never fails
 * a build or page render that has no backend configured (CI builds, flag-gated routes).
 */
export function getFeatureFlags(): FeatureFlags {
  return parseFeatureFlags({
    NEXT_PUBLIC_ENABLE_QUOTES: process.env.NEXT_PUBLIC_ENABLE_QUOTES,
    NEXT_PUBLIC_ENABLE_CSV_IMPORT: process.env.NEXT_PUBLIC_ENABLE_CSV_IMPORT,
    NEXT_PUBLIC_ENABLE_BILLING: process.env.NEXT_PUBLIC_ENABLE_BILLING,
    NEXT_PUBLIC_ENABLE_EMAIL: process.env.NEXT_PUBLIC_ENABLE_EMAIL,
    NEXT_PUBLIC_ENABLE_AI: process.env.NEXT_PUBLIC_ENABLE_AI,
    NEXT_PUBLIC_ENABLE_INTEGRATIONS: process.env.NEXT_PUBLIC_ENABLE_INTEGRATIONS,
  });
}
