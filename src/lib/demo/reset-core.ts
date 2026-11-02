import type { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError, RateLimitError } from "@/lib/api/errors";
import { mapPostgresError } from "@/lib/api/postgres-errors";

export type ResetResult = { organizationId: string; resetAt: string; expiresAt: string };

/**
 * Resets the calling guest's OWN demo workspace through `reset_demo_workspace` (ownership, expiry, the one-a-minute
 * throttle and the atomic re-seed are enforced in the database). The workspace is found with the caller's own session,
 * so there is no organization id in the request to tamper with. A throttled reset becomes a 429 whose message says how
 * many seconds to wait.
 */
export async function resetOwnDemo(
  supabase: SupabaseClient<any, any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any -- generic over any Database
): Promise<ResetResult> {
  const own = await supabase
    .from("demo_workspaces")
    .select("organization_id")
    .limit(1)
    .maybeSingle();
  if (own.error) throw own.error;
  if (!own.data) throw new NotFoundError("You do not have a demo workspace yet.", "DEMO_NOT_FOUND");

  const { data, error } = await supabase.rpc("reset_demo_workspace", {
    org_id: (own.data as { organization_id: string }).organization_id,
  });
  if (error) {
    const mapped = mapPostgresError(error);
    if (mapped instanceof RateLimitError && mapped.retryAfterSeconds) {
      const n = mapped.retryAfterSeconds;
      throw new RateLimitError(
        `You can reset the demo once a minute. Try again in ${n} ${n === 1 ? "second" : "seconds"}.`,
        n,
        mapped.code,
      );
    }
    throw mapped ?? error;
  }
  const row = data as { organization_id: string; reset_at: string; expires_at: string };
  return { organizationId: row.organization_id, resetAt: row.reset_at, expiresAt: row.expires_at };
}
