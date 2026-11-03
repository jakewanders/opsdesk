import type { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError, ValidationError } from "@/lib/api/errors";
import type { OrgContext } from "@/lib/api/org-context";
import {
  MAX_REPORT_DAYS,
  REPORT_METRICS,
  resolveRange,
  type ReportBucket,
} from "@/lib/domain/reports";
import { STAGES, type Stage } from "@/lib/domain/pipeline";
import { todayInZone } from "@/lib/domain/tasks";
import { assertCan } from "@/lib/permissions";
import type { Database } from "@/lib/supabase/database.types";
import type { ReportQuery } from "./schema";

export const SOURCES = ["referral", "website", "outbound", "other"] as const;

/**
 * The reports. Series are EVENT-based (a dated, persisted fact inside the range); `opportunitiesByStage` is CURRENT-state (now, not
 * the range). `metrics` says which is which, in words. Calendar days are the organization's.
 */
export type ReportDto = {
  generatedAt: string;
  timeZone: string;
  today: string;
  range: { from: string; to: string; days: number; bucket: "day" | "week"; preset: number | null };
  buckets: ReportBucket[];
  customersBySource: Record<(typeof SOURCES)[number], number>;
  opportunitiesByStage: Record<Stage, { count: number; amountCents: number }>;
  metrics: typeof REPORT_METRICS;
};

type Summary = {
  from: string;
  to: string;
  days: number;
  bucket: "day" | "week";
  timeZone: string;
  today: string;
  buckets: ReportBucket[];
  customersBySource: Partial<Record<(typeof SOURCES)[number], number>>;
  opportunitiesByStage: Partial<Record<Stage, { count: number; amountCents: number }>>;
};

/** Everyone who can read the workspace can read its reports. */
export async function getReport(
  supabase: SupabaseClient<Database>,
  ctx: OrgContext,
  query: ReportQuery,
  now: Date = new Date(),
): Promise<ReportDto> {
  assertCan(ctx.role, ctx.kind, "records.read");
  const today = todayInZone(now, ctx.org.timezone);
  const range = resolveRange(query, today);
  if (!range) {
    const field = query.from !== undefined ? "to" : "range";
    throw new ValidationError("That date range is not valid.", {
      [field]: [`Choose a range of 1 to ${MAX_REPORT_DAYS} days that ends on or after its start.`],
    });
  }
  const { data, error } = await supabase.rpc("report_summary", {
    p_org_id: ctx.org.id,
    p_from: range.from,
    p_to: range.to,
  });
  if (error) {
    if (error.code === "OD404") throw new NotFoundError("That workspace was not found.");
    throw error;
  }
  const s = data as unknown as Summary;
  return {
    generatedAt: now.toISOString(),
    timeZone: s.timeZone,
    today: s.today,
    range: {
      from: s.from,
      to: s.to,
      days: s.days,
      bucket: s.bucket,
      preset: query.from === undefined ? (query.range ?? 30) : null,
    },
    buckets: s.buckets,
    customersBySource: Object.fromEntries(
      SOURCES.map((source) => [source, s.customersBySource[source] ?? 0]),
    ) as ReportDto["customersBySource"],
    opportunitiesByStage: Object.fromEntries(
      STAGES.map((stage) => [stage, s.opportunitiesByStage[stage] ?? { count: 0, amountCents: 0 }]),
    ) as ReportDto["opportunitiesByStage"],
    metrics: REPORT_METRICS,
  };
}
