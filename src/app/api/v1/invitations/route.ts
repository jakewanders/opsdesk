import { created, okList } from "@/lib/api/envelope";
import { withOrgApi } from "@/lib/api/handler";
import { getPublicEnv } from "@/lib/env/public";
import { createInvitationSchema } from "@/features/members/schema";
import { createInvitation, listInvitations } from "@/features/members/service";
import { parseBody } from "@/lib/validation";

/**
 * GET /api/v1/invitations: the workspace's open invitations (owner and admin only). Metadata only: the address, role,
 * inviter and expiry. A token or its hash is never returned here.
 */
export const GET = withOrgApi(async ({ supabase, org }) => {
  const items = await listInvitations(supabase, org);
  return okList(items, { total: items.length });
});

/**
 * POST /api/v1/invitations: invite an address as admin, member or viewer (201). Owner and admin only, real workspaces
 * only. The response carries the one-time `link` (and `token`): it is shown once and cannot be retrieved again. The link
 * puts the token in the URL fragment, so it is never sent to a server or a `Referer`.
 */
export const POST = withOrgApi(async ({ request, supabase, org }) => {
  const input = await parseBody(createInvitationSchema, request);
  const made = await createInvitation(supabase, org, input);
  const origin = getPublicEnv().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  return created({
    id: made.id,
    email: input.email,
    role: input.role,
    expiresAt: made.expiresAt,
    token: made.token,
    link: `${origin}/invite#token=${made.token}`,
  });
});
