// Scheduled Function: purge expired demo workspaces and their anonymous users (SIT-213, PRD 8.2).
//
// Runs hourly (decision recorded in docs/DECISIONS.md). The schedule is the only trigger: there is no public route to it. Netlify
// scheduled functions are bounded (the cleanup core stops starting work after its time budget and is idempotent, so a run that
// stops early is simply continued by the next one). Only counts and error codes are logged. Needs SUPABASE_SECRET_KEY and
// NEXT_PUBLIC_SUPABASE_URL in the site's environment variables (server-only; never in the repository).
import { createClient } from "@supabase/supabase-js";
import { cleanupExpiredDemos } from "../../src/lib/cleanup/cleanup";
import { evaluateCleanupTarget, exitCodeFor } from "../../src/lib/cleanup/guard";
import { logger } from "../../src/lib/logger/logger";

export default async function handler(): Promise<Response> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  const target = evaluateCleanupTarget({ url, secretKey, scheduled: true });
  if (!target.ok) {
    logger.error("demo_cleanup.refused", { errorCode: target.code });
    return new Response(JSON.stringify({ ok: false, code: target.code }), { status: 500 });
  }
  const admin = createClient(url!, secretKey!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  try {
    const result = await cleanupExpiredDemos(admin as never, {
      log: (event) => logger.info(String(event.event ?? "demo_cleanup"), event),
    });
    const failed = exitCodeFor(result) === 1;
    return new Response(
      JSON.stringify({
        ok: !failed,
        orgsDeleted: result.orgsDeleted,
        usersDeleted: result.usersDeleted,
        errors: result.errors,
        errorCodes: result.errorCodes,
        truncated: result.truncated,
      }),
      { status: failed ? 500 : 200 },
    );
  } catch (error) {
    logger.error("demo_cleanup.failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
    });
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }
}

export const config = { schedule: "@hourly" };
