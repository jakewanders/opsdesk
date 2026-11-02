import { created, okList } from "@/lib/api/envelope";
import { withOrgApi } from "@/lib/api/handler";
import { readIdempotencyKey, withIdempotency } from "@/lib/api/idempotency";
import { createForOrg, listForOrg } from "@/features/quotes/service";
import { createQuoteSchema, quoteListQuery } from "@/features/quotes/schema";
import { parseBody, parseQuery } from "@/lib/validation";

/**
 * GET /api/v1/quotes: one page of the workspace's quotes. `page`, `limit` (default 25, at most 100), `sort` (`updated_at` default,
 * `created_at`, `quote_number`, `title`, `total_cents`, `issue_date`, `status`) and `order`; filters `q` (number or title),
 * `status`, `customerId`, `opportunityId`, `issueFrom`, `issueTo`, `archived` (`false` default, `true`, `all`). Disabled with
 * `NEXT_PUBLIC_ENABLE_QUOTES=false` (404).
 */
export const GET = withOrgApi(
  async ({ request, supabase, org }) => {
    const query = parseQuery(quoteListQuery, new URL(request.url).searchParams);
    const { items, meta } = await listForOrg(supabase, org, query);
    return okList(items, meta);
  },
  { authorize: "records.read", feature: "quotes" },
);

/**
 * POST /api/v1/quotes: create a draft (201) from a customer, optional deal, header fields and 1 to 100 lines. The response carries
 * the quote number and totals the SERVER computed: a body that names a total, a subtotal, a number or a status is a 422. Owner,
 * admin and member (and a demo guest in their own demo). An `Idempotency-Key` makes a retry return the original quote.
 */
export const POST = withOrgApi(
  async ({ request, supabase, org }) => {
    const key = readIdempotencyKey(request);
    const input = await parseBody(createQuoteSchema, request);
    return withIdempotency(
      supabase,
      { route: "POST /api/v1/quotes", key, payload: { org: org.org.id, ...input } },
      async () => created(await createForOrg(supabase, org, input)),
    );
  },
  { authorize: "quotes.write", feature: "quotes" },
);
