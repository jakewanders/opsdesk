import { okList } from "@/lib/api/envelope";
import { withOrgApi } from "@/lib/api/handler";
import { activityListQuery } from "@/features/activity/schema";
import { listActivity } from "@/features/activity/service";
import { parseQuery } from "@/lib/validation";

/**
 * GET /api/v1/activity: one page of the workspace's activity feed, newest first. `page`, `limit` (default 25, at most
 * 100), `order`; filters `entityType`, `entityId`, `action`, `actor` (a user id or `system`) and `from` / `to` (inclusive
 * calendar days in the organization's time zone). `meta` carries `page`, `limit`, `total` and `totalPages`. Any member can
 * read it, viewers included; events of other workspaces are never returned.
 */
export const GET = withOrgApi(
  async ({ request, supabase, org }) => {
    const query = parseQuery(activityListQuery, new URL(request.url).searchParams);
    const { items, meta } = await listActivity(supabase, org, query);
    return okList(items, meta);
  },
  { authorize: "records.read" },
);
