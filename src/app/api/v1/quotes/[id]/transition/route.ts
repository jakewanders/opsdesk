import { okItem } from "@/lib/api/envelope";
import { BadRequestError } from "@/lib/api/errors";
import { withOrgApi } from "@/lib/api/handler";
import { transitionForOrg } from "@/features/quotes/service";
import { transitionQuoteSchema } from "@/features/quotes/schema";
import { parseBody, uuid } from "@/lib/validation";

/**
 * POST /api/v1/quotes/:id/transition: `{ "to": "sent" | "approved" | "rejected" | "expired" }`. Allowed: draft to sent (needs at
 * least one line), sent to approved, rejected or expired; anything else is 409 `QUOTE_STATUS_TRANSITION`. `expectedVersion` is
 * optional (the current version is used without it). In a demo workspace "sent" only changes the status: nothing is delivered.
 */
export const POST = withOrgApi<{ id: string }>(
  async ({ params, request, supabase, org }) => {
    const id = uuid().safeParse(params.id);
    if (!id.success) throw new BadRequestError("That quote id is not valid.");
    const input = await parseBody(transitionQuoteSchema, request);
    return okItem(await transitionForOrg(supabase, org, id.data, input));
  },
  { authorize: "quotes.write", feature: "quotes" },
);
