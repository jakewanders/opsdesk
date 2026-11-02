import type { SupabaseClient } from "@supabase/supabase-js";
import { listRecentActivity, type RecentActivityDto } from "@/features/activity/repository";
import type { OrgContext } from "@/lib/api/org-context";
import { NotFoundError } from "@/lib/api/errors";
import { STAGES, type Stage } from "@/lib/domain/pipeline";
import { assertCan } from "@/lib/permissions";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The dashboard's numbers. All CURRENT STATE as of `generatedAt` (not trends, not estimates): counts and sums of stored,
 * unarchived records. `today` and `timeZone` are the organization's, which decide what "overdue" and "next 7 days" mean.
 */
export type DashboardDto = {
  basis: "current_state";
  generatedAt: string;
  today: string;
  timeZone: string;
  activeCustomers: number;
  openOpportunities: number;
  pipelineCents: number;
  weightedPipelineCents: number;
  overdueTasks: number;
  tasksDueNext7Days: number;
  opportunitiesByStage: Record<Stage, { count: number; amountCents: number }>;
  recentActivity: RecentActivityDto[];
};

type Summary = Omit<DashboardDto, "basis" | "generatedAt" | "recentActivity">;

/** Everyone who can read the workspace can read its dashboard. */
export async function getDashboard(
  supabase: SupabaseClient<Database>,
  ctx: OrgContext,
): Promise<DashboardDto> {
  assertCan(ctx.role, ctx.kind, "records.read");
  const [summary, recentActivity] = await Promise.all([
    supabase.rpc("dashboard_summary", { p_org_id: ctx.org.id }),
    listRecentActivity(supabase, ctx.org.id, 10),
  ]);
  if (summary.error) {
    if (summary.error.code === "OD404") throw new NotFoundError("That workspace was not found.");
    throw summary.error;
  }
  const s = summary.data as unknown as Summary;
  // every stage is present, empty ones as zero, in pipeline order
  const byStage = Object.fromEntries(
    STAGES.map((stage) => [stage, s.opportunitiesByStage[stage] ?? { count: 0, amountCents: 0 }]),
  ) as DashboardDto["opportunitiesByStage"];
  return {
    basis: "current_state",
    generatedAt: new Date().toISOString(),
    today: s.today,
    timeZone: s.timeZone,
    activeCustomers: s.activeCustomers,
    openOpportunities: s.openOpportunities,
    pipelineCents: s.pipelineCents,
    weightedPipelineCents: s.weightedPipelineCents,
    overdueTasks: s.overdueTasks,
    tasksDueNext7Days: s.tasksDueNext7Days,
    opportunitiesByStage: byStage,
    recentActivity,
  };
}
