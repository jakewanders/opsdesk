import { okItem } from "@/lib/api/envelope";
import { withApi } from "@/lib/api/handler";
import { acceptInvitationSchema } from "@/features/members/schema";
import { acceptInvitation } from "@/features/members/service";
import { createClient } from "@/lib/supabase/server";
import { parseBody } from "@/lib/validation";

/**
 * POST /api/v1/invitations/accept: join the workspace an invitation names. The caller must be signed in with a confirmed
 * email equal to the invited address. Not tied to an active workspace (the caller may belong to none yet), so it does not
 * need `X-Organization-Id`. Refusals have stable codes: 404 `INVITATION_INVALID`; 409 `INVITATION_REVOKED`,
 * `INVITATION_USED`, `INVITATION_EXPIRED`; 403 `EMAIL_UNVERIFIED`, `EMAIL_MISMATCH` (and `ACCOUNT_REQUIRED` for a demo
 * guest); 429 `RATE_LIMITED` after 10 attempts in 15 minutes.
 */
export const POST = withApi(async ({ request }) => {
  const { token } = await parseBody(acceptInvitationSchema, request);
  const supabase = await createClient();
  return okItem(await acceptInvitation(supabase, token));
});
