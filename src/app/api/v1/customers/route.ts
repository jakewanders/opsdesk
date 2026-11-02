import { created, okList } from "@/lib/api/envelope";
import { withOrgApi } from "@/lib/api/handler";
import { createForOrg, listForOrg } from "@/features/customers/service";
import { createCustomerSchema, customerListQuery } from "@/features/customers/schema";
import { parseBody, parseQuery } from "@/lib/validation";

/**
 * GET /api/v1/customers: one page of the workspace's customers. `page`, `limit` (default 25, at most 100), `sort`
 * (`updated_at` default, `created_at`, `display_name`, `status`) and `order`; filters `q` (name, company, e-mail),
 * `status`, `source`, `assignedTo`, `archived` (`false` default, `true`, `all`). `meta` carries `page`, `limit`, `total`
 * and `totalPages`.
 */
export const GET = withOrgApi(async ({ request, supabase, org }) => {
  const query = parseQuery(customerListQuery, new URL(request.url).searchParams);
  const { items, meta } = await listForOrg(supabase, org, query);
  return okList(items, meta);
});

/**
 * POST /api/v1/customers: create a customer (201). Owner, admin and member only. A duplicate e-mail returns the
 * record with `meta.warnings`, it does not fail.
 */
export const POST = withOrgApi(async ({ request, supabase, org }) => {
  const input = await parseBody(createCustomerSchema, request);
  const { customer, warnings } = await createForOrg(supabase, org, input);
  return created(customer, warnings.length > 0 ? { warnings } : {});
});
