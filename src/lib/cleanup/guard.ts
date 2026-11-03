/**
 * The safety checks in front of every manual or scheduled cleanup run (PRD 8.2, SIT-213). Pure, so it is unit-tested.
 *
 * - The secret key and the project URL must both be set: nothing is guessed or defaulted.
 * - A LOCAL URL (localhost, 127.0.0.1, ::1) runs without ceremony.
 * - Any other URL is a real project. The command line needs `--confirm-remote <hostname>` naming that exact hostname, so a stale
 *   environment variable can never aim a delete at the wrong project by accident. The scheduled function has no command line; it
 *   passes `scheduled: true`, which only the Netlify runtime can do, and it still needs the same two variables.
 * The cleanup itself only ever deletes expired DEMO organizations and eligible anonymous users (see cleanup.ts); this guard is about
 * not pointing it at the wrong place.
 */
export type CleanupTargetInput = {
  url: string | undefined;
  secretKey: string | undefined;
  /** The value given after `--confirm-remote`, if any. */
  confirmRemote?: string | undefined;
  /** True only inside the Netlify Scheduled Function. */
  scheduled?: boolean;
};

export type CleanupTarget =
  | { ok: true; host: string; local: boolean }
  | {
      ok: false;
      code: "MISSING_URL" | "MISSING_SECRET" | "BAD_URL" | "CONFIRM_REQUIRED";
      message: string;
    };

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function evaluateCleanupTarget(input: CleanupTargetInput): CleanupTarget {
  if (!input.url)
    return {
      ok: false,
      code: "MISSING_URL",
      message: "Set NEXT_PUBLIC_SUPABASE_URL (the project to clean).",
    };
  if (!input.secretKey)
    return {
      ok: false,
      code: "MISSING_SECRET",
      message: "Set SUPABASE_SECRET_KEY (server only; never commit it).",
    };
  let host: string;
  try {
    host = new URL(input.url).hostname.toLowerCase();
  } catch {
    return { ok: false, code: "BAD_URL", message: "NEXT_PUBLIC_SUPABASE_URL is not a valid URL." };
  }
  const local = LOCAL.has(host);
  if (local || input.scheduled) return { ok: true, host, local };
  if (input.confirmRemote?.toLowerCase() === host) return { ok: true, host, local };
  return {
    ok: false,
    code: "CONFIRM_REQUIRED",
    message: `This is not a local project (${host}). To run the cleanup against it, repeat the command with --confirm-remote ${host}`,
  };
}

/** A summary line that is safe to log: counts and codes only. */
export function exitCodeFor(result: { errors: number; truncated: boolean }): 0 | 1 {
  return result.errors > 0 ? 1 : 0;
}
