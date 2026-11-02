import { ForbiddenError } from "@/lib/api/errors";
import { okItem, type ApiResult } from "@/lib/api/envelope";
import { withApi } from "@/lib/api/handler";
import { readIdempotencyKey, withIdempotency } from "@/lib/api/idempotency";
import { bootstrapDemoWorkspace } from "@/lib/demo/bootstrap";
import { rememberWorkspace } from "@/lib/org/remember-workspace";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/v1/demo/bootstrap: gives the signed-in GUEST their demo workspace (created and seeded on first call,
 * the same one on every later call) and returns its id and expiry. The client sends an `Idempotency-Key`, so a
 * retry after a lost response returns the original answer. Registered users get 403: a real account never gets
 * a demo workspace. The workspace becomes the active one (UI preference cookie, re-verified on every request).
 */
export const POST = withApi(async ({ request, user }) => {
  if (!user!.isAnonymous) {
    throw new ForbiddenError(
      "The live demo is for guest visitors. Sign out to try it.",
      "GUEST_ONLY",
    );
  }
  const key = readIdempotencyKey(request);
  const supabase = await createClient();
  const result: ApiResult = await withIdempotency(
    supabase,
    { route: "POST /api/v1/demo/bootstrap", key, payload: {} },
    async () => okItem(await bootstrapDemoWorkspace(supabase)),
  );
  const data = result.body?.data as { organizationId?: string } | undefined;
  if (data?.organizationId) await rememberWorkspace(data.organizationId);
  return result;
});
