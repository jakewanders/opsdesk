/**
 * Pure shaping of the first-party usage counts (P-03, SIT-146) into a per-day table, totals and rates. The rows come from the
 * database function `usage_report(days)`: (UTC day, metric, count). Nothing here sees an identifier: only counts exist.
 */
export type UsageRow = { day: string; metric: string; total: number | string };

export const METRICS = [
  "demos_started",
  "demos_in_progress",
  "demos_with_customer_created",
  "demos_with_stage_move",
  "demos_with_task_completed",
  "demos_with_quote_created",
  "demos_reset",
  "demos_expired_unused",
  "real_accounts_created",
] as const;
export type Metric = (typeof METRICS)[number];
export type UsageCounts = Record<Metric, number>;
export type UsageDay = { day: string } & UsageCounts;

export type UsageReport = {
  days: UsageDay[];
  totals: UsageCounts;
  /** Percent of demos started, rounded to a whole number; null when no demo started. */
  rates: Partial<
    Record<
      Exclude<Metric, "demos_started" | "demos_in_progress" | "real_accounts_created">,
      number | null
    >
  >;
};

const emptyCounts = (): UsageCounts =>
  Object.fromEntries(METRICS.map((m) => [m, 0])) as UsageCounts;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The `days` UTC days ending at `today` (inclusive), oldest first. */
export function dayRange(days: number, today: Date): string[] {
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Array.from({ length: days }, (_, i) =>
    isoDay(new Date(end - (days - 1 - i) * 86_400_000)),
  );
}

export function rate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

export function buildUsageReport(rows: UsageRow[], days: number, today: Date): UsageReport {
  const byDay = new Map<string, UsageDay>(
    dayRange(days, today).map((day) => [day, { day, ...emptyCounts() }]),
  );
  const known = new Set<string>(METRICS);
  for (const row of rows) {
    const entry = byDay.get(row.day);
    if (!entry || !known.has(row.metric)) continue; // outside the window, or a metric this version does not show
    entry[row.metric as Metric] += Number(row.total);
  }
  const list = [...byDay.values()];
  const totals = emptyCounts();
  for (const d of list) for (const m of METRICS) totals[m] += d[m];
  const started = totals.demos_started;
  return {
    days: list,
    totals,
    rates: {
      demos_with_customer_created: rate(totals.demos_with_customer_created, started),
      demos_with_stage_move: rate(totals.demos_with_stage_move, started),
      demos_with_task_completed: rate(totals.demos_with_task_completed, started),
      demos_with_quote_created: rate(totals.demos_with_quote_created, started),
      demos_reset: rate(totals.demos_reset, started),
      demos_expired_unused: rate(totals.demos_expired_unused, started),
    },
  };
}

const COLUMNS: Array<{ head: string; metric: Metric }> = [
  { head: "started", metric: "demos_started" },
  { head: "running", metric: "demos_in_progress" },
  { head: "customer", metric: "demos_with_customer_created" },
  { head: "stage", metric: "demos_with_stage_move" },
  { head: "task", metric: "demos_with_task_completed" },
  { head: "quote", metric: "demos_with_quote_created" },
  { head: "reset", metric: "demos_reset" },
  { head: "unused", metric: "demos_expired_unused" },
  { head: "signups", metric: "real_accounts_created" },
];

/** A fixed-width text table: one row per UTC day, then the totals and the rates. Counts and percentages only. */
export function formatUsageReport(report: UsageReport): string {
  const widths = COLUMNS.map((c) => Math.max(c.head.length, 5));
  const dayWidth = 10;
  const line = (label: string, cells: string[]) =>
    label.padEnd(dayWidth) + "  " + cells.map((c, i) => c.padStart(widths[i])).join("  ");
  const out: string[] = [];
  out.push(
    line(
      "day (UTC)",
      COLUMNS.map((c) => c.head),
    ),
  );
  out.push("-".repeat(dayWidth + 2 + widths.reduce((a, w) => a + w + 2, -2)));
  for (const d of report.days)
    out.push(
      line(
        d.day,
        COLUMNS.map((c) => String(d[c.metric])),
      ),
    );
  out.push("-".repeat(out[1].length));
  out.push(
    line(
      "total",
      COLUMNS.map((c) => String(report.totals[c.metric])),
    ),
  );
  out.push(
    line(
      "% started",
      COLUMNS.map((c) => {
        const r = (report.rates as Record<string, number | null | undefined>)[c.metric];
        return r === undefined ? "" : r === null ? "-" : `${r}%`;
      }),
    ),
  );
  return out.join("\n");
}

export const REPORT_NOTES = [
  "Each demo is counted on the UTC day it was created. A day's numbers are final once its demos have expired and been cleaned up (24 hours).",
  "running = demos still inside their 24 hours: counted in `started` and in the feature columns so far, never in `unused` yet.",
  "customer / stage / task / quote = demos where a visitor (not the seeded sample data) did that at least once, including before a reset.",
  "unused = expired demos where the visitor changed nothing and never reset. Looking around without changing anything cannot be measured.",
  "signups = registered (non-guest) accounts created that day, counted from the accounts table when this report runs.",
];
