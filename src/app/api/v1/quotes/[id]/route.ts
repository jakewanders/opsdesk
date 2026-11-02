import { okItem } from "@/lib/api/envelope";
import { BadRequestError } from "@/lib/api/errors";
import { withOrgApi } from "@/lib/api/handler";
import { getForOrg, updateForOrg } from "@/features/quotes/service";
import { updateQuoteSchema } from "@/features/quotes/schema";
import { parseBody, uuid } from "@/lib/validation";

type Params = { id: string };

/** The id in the path: a malformed one is a 400, a well-formed one the caller cannot see is a 404. */
function quoteId(params: Params): string {
  const parsed = uuid().safeParse(params.id);
  if (!parsed.success) throw new BadRequestError("That quote id is not valid.");
  return parsed.data;
}

/** GET /api/v1/quotes/:id: the quote with its lines, the quote it revises, the revisions made from it and its status history. */
export const GET = withOrgApi<Params>(
  async ({ params, supabase, org }) => okItem(await getForOrg(supabase, org, quoteId(params))),
  { authorize: "records.read", feature: "quotes" },
);

/**
 * PATCH /api/v1/quotes/:id: edit a DRAFT. Send `expectedVersion` (the version you saw): a stale one is 409 `STALE_EDIT` with the
 * current version in `error.meta`. A quote that has been sent is 409 `QUOTE_LOCKED` (revise it instead). Lines, when sent,
 * replace all lines; totals are recomputed by the server.
 */
export const PATCH = withOrgApi<Params>(
  async ({ params, request, supabase, org }) => {
    const id = quoteId(params);
    const input = await parseBody(updateQuoteSchema, request);
    return okItem(await updateForOrg(supabase, org, id, input));
  },
  { authorize: "quotes.write", feature: "quotes" },
);
