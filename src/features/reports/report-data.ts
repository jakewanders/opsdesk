import { defineUrlState, urlField, type UrlState } from "@/lib/api-client/url-state";
import { daysBetween, MAX_REPORT_DAYS, type ReportBucket } from "@/lib/domain/reports";
import { isIsoDate, todayInZone } from "@/lib/domain/tasks";

/**
 * The reports page's state as it lives in the URL: a preset (7, 30 or 90 days) or `custom` with `from` and `to`. Defaults are left
 * out, so the default view has a clean URL. Dates are calendar days in the workspace's time zone.
 */
export const reportUrl = defineUrlState({
  range: urlField.enum(["7", "30", "90", "custom"], "30"),
  from: urlField.string("", 10),
  to: urlField.string("", 10),
});
export type ReportUrlState = UrlState<typeof reportUrl>;

/** The API query for a URL state. A `custom` range without two valid dates falls back to the default preset. */
export function toApiQuery(state: ReportUrlState): Record<string, string | number | undefined> {
  if (state.range === "custom") {
    if (customRangeProblem(state.from, state.to) === null)
      return { from: state.from, to: state.to };
    return {};
  }
  return { range: Number(state.range) };
}

/** Why a custom range cannot be used, in words, or null when it can. */
export function customRangeProblem(from: string, to: string): string | null {
  if (!isIsoDate(from) || !isIsoDate(to)) return "Choose both a start and an end date.";
  if (to < from) return "The end date is before the start date.";
  if (daysBetween(from, to) + 1 > MAX_REPORT_DAYS) return `Choose at most ${MAX_REPORT_DAYS} days.`;
  return null;
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const DAY_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const at = (date: string) => new Date(`${date}T00:00:00Z`);

/** "Oct 3 to Nov 1, 2026, America/New_York": the exact range, with the year once when it is the same and the zone always. */
export function formatRange(from: string, to: string, timeZone: string): string {
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  if (from === to) return `${DAY_YEAR.format(at(from))}, ${timeZone}`;
  const start = sameYear ? DAY.format(at(from)) : DAY_YEAR.format(at(from));
  return `${start} to ${DAY_YEAR.format(at(to))}, ${timeZone}`;
}

/** A bucket's label: one day, or the days a week-long bucket covers. */
export function bucketLabel(b: Pick<ReportBucket, "start" | "end">): string {
  return b.start === b.end
    ? DAY.format(at(b.start))
    : `${DAY.format(at(b.start))} to ${DAY.format(at(b.end))}`;
}

export type TrendRow = {
  label: string;
  created: number;
  won: number;
  lost: number;
  completed: number;
};

export function trendRows(buckets: ReportBucket[]): TrendRow[] {
  return buckets.map((b) => ({
    label: bucketLabel(b),
    created: b.opportunitiesCreated,
    won: b.opportunitiesWon,
    lost: b.opportunitiesLost,
    completed: b.tasksCompleted,
  }));
}

/** Wins as a share of the deals closed in the range (won + lost). Null when nothing closed: there is no rate to show. */
export function winRate(
  buckets: ReportBucket[],
): { won: number; closed: number; percent: number } | null {
  const won = buckets.reduce((n, b) => n + b.opportunitiesWon, 0);
  const lost = buckets.reduce((n, b) => n + b.opportunitiesLost, 0);
  if (won + lost === 0) return null;
  return { won, closed: won + lost, percent: Math.round((won / (won + lost)) * 100) };
}

export function eventTotals(buckets: ReportBucket[]) {
  const sum = (
    k: "opportunitiesCreated" | "opportunitiesWon" | "opportunitiesLost" | "tasksCompleted",
  ) => buckets.reduce((n, b) => n + b[k], 0);
  return {
    created: sum("opportunitiesCreated"),
    won: sum("opportunitiesWon"),
    lost: sum("opportunitiesLost"),
    completed: sum("tasksCompleted"),
  };
}

/**
 * The calendar day the workspace was created, when the range starts before it (so the earlier days cannot hold data and the page says
 * so). Null when the whole range is on or after that day.
 */
export function workspaceStartedAfter(
  from: string,
  workspaceCreatedAt: string | null,
  timeZone: string,
): string | null {
  if (!workspaceCreatedAt) return null;
  const created = todayInZone(new Date(workspaceCreatedAt), timeZone);
  return from < created ? created : null;
}

export const SOURCE_LABELS: Record<string, string> = {
  referral: "Referral",
  website: "Website",
  outbound: "Outbound",
  other: "Other",
};
