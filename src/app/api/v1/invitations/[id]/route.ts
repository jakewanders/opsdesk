import { noContent } from "@/lib/api/envelope";
import { BadRequestError } from "@/lib/api/errors";
import { withOrgApi } from "@/lib/api/handler";
import { revokeInvitation } from "@/features/members/service";
import { uuid } from "@/lib/validation";

type Params = { id: string };

/** DELETE /api/v1/invitations/:id: withdraw an open invitation (204, idempotent; an accepted one is 409). Owner and admin only. */
export const DELETE = withOrgApi<Params>(async ({ params, supabase, org }) => {
  const id = uuid().safeParse(params.id);
  if (!id.success) throw new BadRequestError("That invitation id is not valid.");
  await revokeInvitation(supabase, org, id.data);
  return noContent();
});
