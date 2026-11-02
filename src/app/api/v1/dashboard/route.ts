import { okItem } from "@/lib/api/envelope";
import { withOrgApi } from "@/lib/api/handler";
import { getDashboard } from "@/features/dashboard/service";

/**
 * GET /api/v1/dashboard: the active workspace's current-state KPIs (customers, pipeline, weighted pipeline, overdue and
 * upcoming tasks, deals by stage) and its 10 newest activity events. Computed by the database with the caller's own
 * session, so another workspace's rows can never be counted. Any member (viewers included) can read it.
 */
export const GET = withOrgApi(
  async ({ supabase, org }) => okItem(await getDashboard(supabase, org)),
  { authorize: "records.read" },
);
