import { okItem } from "@/lib/api/envelope";
import { withOrgApi } from "@/lib/api/handler";
import { reportQuery } from "@/features/reports/schema";
import { getReport } from "@/features/reports/service";
import { parseQuery } from "@/lib/validation";

/**
 * GET /api/v1/reports: date-range aggregates in the organization's time zone. `range` is 7, 30 (default) or 90 days ending today,
 * or give `from` and `to` (`YYYY-MM-DD`, both included, at most 366 days). Up to 31 days the series has one bucket per day, longer
 * ranges use 7-day buckets from the first day; every bucket is present, zero-filled. Series are event-based (created, won, lost,
 * completed); deals by stage is the current state. Computed by the database with the caller's own session. Any member, viewers
 * included, can read it.
 */
export const GET = withOrgApi(
  async ({ request, supabase, org }) => {
    const query = parseQuery(reportQuery, new URL(request.url).searchParams);
    return okItem(await getReport(supabase, org, query));
  },
  { authorize: "records.read" },
);
