import "server-only";
import { parseServerEnv, type ServerEnv } from "./schema";
import { getPublicEnv } from "./public";

let cached: ServerEnv | undefined;

/**
 * Validated server-only configuration, including secrets. `server-only` makes any
 * import from a Client Component a build error, so these values cannot reach the browser.
 */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv({
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    AI_API_KEY: process.env.AI_API_KEY,
    CONTEXT: process.env.CONTEXT,
  });
  return cached;
}

/** Fail fast at server start: validates public and server configuration together. */
export function assertEnv(): void {
  getPublicEnv();
  getServerEnv();
}

/** For features that need a secret: throws a readable error when it is not configured. */
export function requireSecret(name: keyof ServerEnv): string {
  const value = getServerEnv()[name];
  if (!value) throw new Error(`${name} is not configured. Set it in the server environment.`);
  return value;
}
