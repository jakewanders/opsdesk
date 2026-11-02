import { created, okList } from "@/lib/api/envelope";
import { withOrgApi } from "@/lib/api/handler";
import { createOpportunitySchema, opportunityListQuery } from "@/features/opportunities/schema";
import { createForOrg, listForOrg } from "@/features/opportunities/service";
import { parseBody, parseQuery } from "@/lib/validation";

/**
 * GET /api/v1/opportunities: one page of the workspace's deals. `page`, `limit` (default 25, at most 100), `sort`
 * (`updated_at` default, `created_at`, `title`, `amount_cents`, `expected_close_date`, `stage`) and `order`; filters
 * `q` (title and customer name), `stage`, `assignedTo`, `customerId`, `closeFrom`, `closeTo`, `archived`. `meta` has the
 * pagination fields plus `stageTotals` (count and cents per stage), `openPipelineCents` and `weightedPipelineCents`
 * for the whole filtered set.
 */
export const GET = withOrgApi(
  async ({ request, supabase, org }) => {
    const query = parseQuery(opportunityListQuery, new URL(request.url).searchParams);
    const { items, meta } = await listForOrg(supabase, org, query);
    return okList(items, meta);
  },
  { authorize: "records.read" },
);

/** POST /api/v1/opportunities: create a deal in an open stage (201). Owner, admin and member only. */
export const POST = withOrgApi(
  async ({ request, supabase, org }) => {
    const input = await parseBody(createOpportunitySchema, request);
    return created(await createForOrg(supabase, org, input));
  },
  { authorize: "records.write" },
);
