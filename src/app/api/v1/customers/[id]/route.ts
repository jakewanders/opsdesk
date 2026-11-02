import { noContent, okItem } from "@/lib/api/envelope";
import { BadRequestError } from "@/lib/api/errors";
import { withOrgApi } from "@/lib/api/handler";
import { archiveForOrg, getForOrg, updateForOrg } from "@/features/customers/service";
import { updateCustomerSchema } from "@/features/customers/schema";
import { parseBody, uuid } from "@/lib/validation";

type Params = { id: string };

/** The id in the path: a malformed one is a 400, a well-formed one the caller cannot see is a 404. */
function customerId(params: Params): string {
  const parsed = uuid().safeParse(params.id);
  if (!parsed.success) throw new BadRequestError("That customer id is not valid.");
  return parsed.data;
}

/** GET /api/v1/customers/:id: the customer and the counts of its opportunities, tasks and quotes. */
export const GET = withOrgApi<Params>(
  async ({ params, supabase, org }) => okItem(await getForOrg(supabase, org, customerId(params))),
  { authorize: "records.read" },
);

/**
 * PATCH /api/v1/customers/:id: partial update. Send `updatedAt` as last seen: a stale one is 409 `STALE_EDIT` with
 * the current version in `error.meta`. A change that alters nothing is 200 and writes nothing.
 */
export const PATCH = withOrgApi<Params>(
  async ({ params, request, supabase, org }) => {
    const id = customerId(params);
    const input = await parseBody(updateCustomerSchema, request);
    const { customer, warnings } = await updateForOrg(supabase, org, id, input);
    return okItem(customer, warnings.length > 0 ? { warnings } : {});
  },
  { authorize: "records.write" },
);

/** DELETE /api/v1/customers/:id: archive (soft delete), idempotent, 204. Nothing is ever hard-deleted. */
export const DELETE = withOrgApi<Params>(
  async ({ params, supabase, org }) => {
    await archiveForOrg(supabase, org, customerId(params));
    return noContent();
  },
  { authorize: "records.write" },
);
