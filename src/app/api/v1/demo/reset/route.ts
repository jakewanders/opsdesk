import { ForbiddenError } from "@/lib/api/errors";
import { okItem } from "@/lib/api/envelope";
import { withApi } from "@/lib/api/handler";
import { readIdempotencyKey, withIdempotency } from "@/lib/api/idempotency";
import { resetOwnDemo } from "@/lib/demo/reset-core";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/v1/demo/reset: puts the signed-in guest's own demo workspace back to the original sample data. No body:
 * the workspace is the caller's own. Registered users get 403 (they have no demo). One reset a minute: a faster one is
 * 429 with a "try again in N seconds" message and a `Retry-After` header. A client `Idempotency-Key` makes a retry
 * after a lost response return the original answer instead of resetting again.
 */
export const POST = withApi(async ({ request, user }) => {
  if (!user!.isAnonymous) {
    throw new ForbiddenError("Only guest visitors have a demo to reset.", "GUEST_ONLY");
  }
  const key = readIdempotencyKey(request);
  const supabase = await createClient();
  return withIdempotency(
    supabase,
    { route: "POST /api/v1/demo/reset", key, payload: {} },
    async () => okItem(await resetOwnDemo(supabase)),
  );
});
