import { created } from "@/lib/api/envelope";
import { BadRequestError } from "@/lib/api/errors";
import { withOrgApi } from "@/lib/api/handler";
import { reviseForOrg } from "@/features/quotes/service";
import { uuid } from "@/lib/validation";

/**
 * POST /api/v1/quotes/:id/revise: start a new draft (201) from a quote that has been sent. It gets a new number and points back at the
 * original, which is left exactly as it was. A draft cannot be revised (409 `QUOTE_NOT_REVISABLE`); one open draft revision per
 * quote (409 `REVISION_EXISTS`).
 */
export const POST = withOrgApi<{ id: string }>(
  async ({ params, supabase, org }) => {
    const id = uuid().safeParse(params.id);
    if (!id.success) throw new BadRequestError("That quote id is not valid.");
    return created(await reviseForOrg(supabase, org, id.data));
  },
  { authorize: "quotes.write", feature: "quotes" },
);
