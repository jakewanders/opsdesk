import { noContent, okItem } from "@/lib/api/envelope";
import { BadRequestError } from "@/lib/api/errors";
import { withOrgApi } from "@/lib/api/handler";
import { updateOpportunitySchema } from "@/features/opportunities/schema";
import { archiveForOrg, getForOrg, updateForOrg } from "@/features/opportunities/service";
import { parseBody, uuid } from "@/lib/validation";

type Params = { id: string };

/** The id in the path: a malformed one is a 400, a well-formed one the caller cannot see is a 404. */
function opportunityId(params: Params): string {
  const parsed = uuid().safeParse(params.id);
  if (!parsed.success) throw new BadRequestError("That opportunity id is not valid.");
  return parsed.data;
}

/** GET /api/v1/opportunities/:id: the deal with its customer's name. */
export const GET = withOrgApi<Params>(async ({ params, supabase, org }) =>
  okItem(await getForOrg(supabase, org, opportunityId(params))),
);

/**
 * PATCH /api/v1/opportunities/:id: partial update. Send `expectedUpdatedAt` as last seen: a stale one is 409
 * `STALE_EDIT`. `stage` is refused (422): stage changes use POST /:id/stage.
 */
export const PATCH = withOrgApi<Params>(async ({ params, request, supabase, org }) => {
  const id = opportunityId(params);
  const input = await parseBody(updateOpportunitySchema, request);
  return okItem(await updateForOrg(supabase, org, id, input));
});

/** DELETE /api/v1/opportunities/:id: archive (soft delete), idempotent, 204. */
export const DELETE = withOrgApi<Params>(async ({ params, supabase, org }) => {
  await archiveForOrg(supabase, org, opportunityId(params));
  return noContent();
});
