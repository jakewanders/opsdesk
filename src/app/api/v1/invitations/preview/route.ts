import { okItem } from "@/lib/api/envelope";
import { withApi } from "@/lib/api/handler";
import { acceptInvitationSchema } from "@/features/members/schema";
import { previewInvitation } from "@/features/members/service";
import { createClient } from "@/lib/supabase/server";
import { parseBody } from "@/lib/validation";

/**
 * POST /api/v1/invitations/preview: what an invitation offers before it is accepted (workspace name, role, expiry, a masked
 * form of the invited address, and whether the signed-in account is the invited one). The token is in the body, never the URL.
 * Same refusals as accept (`INVITATION_INVALID`, `INVITATION_REVOKED`, `INVITATION_USED`, `INVITATION_EXPIRED`,
 * `RATE_LIMITED`); lookups count against the same 10-per-15-minutes limit. A demo guest gets 403 `ACCOUNT_REQUIRED`.
 */
export const POST = withApi(async ({ request }) => {
  const { token } = await parseBody(acceptInvitationSchema, request);
  return okItem(await previewInvitation(await createClient(), token));
});
