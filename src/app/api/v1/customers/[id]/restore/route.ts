import { okItem } from "@/lib/api/envelope";
import { BadRequestError } from "@/lib/api/errors";
import { withOrgApi } from "@/lib/api/handler";
import { restoreForOrg } from "@/features/customers/service";
import { uuid } from "@/lib/validation";

/** POST /api/v1/customers/:id/restore: clears `archived_at`. Owner, admin and member; idempotent; returns the customer. */
export const POST = withOrgApi<{ id: string }>(async ({ params, supabase, org }) => {
  const parsed = uuid().safeParse(params.id);
  if (!parsed.success) throw new BadRequestError("That customer id is not valid.");
  return okItem(await restoreForOrg(supabase, org, parsed.data));
});
