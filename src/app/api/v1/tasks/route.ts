import { created, okList } from "@/lib/api/envelope";
import { withOrgApi } from "@/lib/api/handler";
import { createTaskSchema, taskListQuery } from "@/features/tasks/schema";
import { createForOrg, listForOrg } from "@/features/tasks/service";
import { parseBody, parseQuery } from "@/lib/validation";

/**
 * GET /api/v1/tasks: one page of the workspace's tasks. `page`, `limit` (default 25, at most 100), `sort` (`due_date`
 * default, `priority` urgent first when descending, `created_at`, `updated_at`, `title`) and `order`; filters `q`,
 * `status`, `priority`, `assignedTo`, `assignedToMe`, `overdue` (not done and due before today in the organization's
 * time zone), `customerId`, `opportunityId`, `archived`. Tasks without a due date sort last.
 */
export const GET = withOrgApi(async ({ request, supabase, org }) => {
  const query = parseQuery(taskListQuery, new URL(request.url).searchParams);
  const { items, meta } = await listForOrg(supabase, org, query);
  return okList(items, meta);
});

/** POST /api/v1/tasks: create a task (201). Owner, admin and member only. */
export const POST = withOrgApi(async ({ request, supabase, org }) => {
  const input = await parseBody(createTaskSchema, request);
  return created(await createForOrg(supabase, org, input));
});
