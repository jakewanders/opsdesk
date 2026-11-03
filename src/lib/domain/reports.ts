import { addDays, isIsoDate, todayInZone } from "./tasks";

/**
 * The reporting rules in TypeScript (SIT-264). The database function `report_summary` is the source of the numbers; this module is its
 * reference implementation (the parity tests feed both the same events and require identical buckets) and the one place the range
 * rules and the plain-language metric descriptions live.
 *
 * A range is calendar days in the ORGANIZATION's time zone, both ends included. An event belongs to the bucket of its LOCAL date,
 * so a 23- or 25-hour day is still one day. Up to 31 days: one bucket per day. Longer: 7-day buckets that start on the first day of the
 * range (the last may be shorter). Every bucket exists, zero-filled.
 */
export const MAX_REPORT_DAYS = 366;
export const DAILY_BUCKET_MAX_DAYS = 31;
export const RANGE_PRESETS = [7, 30, 90] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const DEFAULT_RANGE: RangePreset = 30;

/** Whole days from `a` to `b` (negative when b is earlier). Calendar arithmetic only, so DST cannot move it. */
export function daysBetween(a: string, b: string): number {
  if (!isIsoDate(a) || !isIsoDate(b)) throw new RangeError("Expected YYYY-MM-DD dates");
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

export type ReportRange = { from: string; to: string };

/** A preset ends today (organization time) and covers that many days; a custom range is used as given. Returns null when invalid. */
export function resolveRange(
  input: { range?: number; from?: string; to?: string },
  today: string,
): ReportRange | null {
  if (input.from !== undefined || input.to !== undefined) {
    if (input.range !== undefined) return null;
    if (!input.from || !input.to) return null;
    return validateRange({ from: input.from, to: input.to });
  }
  const days = input.range ?? DEFAULT_RANGE;
  if (!RANGE_PRESETS.includes(days as RangePreset)) return null;
  return { from: addDays(today, -(days - 1)), to: today };
}

export function validateRange(range: ReportRange): ReportRange | null {
  if (!isIsoDate(range.from) || !isIsoDate(range.to)) return null;
  const span = daysBetween(range.from, range.to) + 1;
  return span >= 1 && span <= MAX_REPORT_DAYS ? range : null;
}

export type BucketPlan = {
  bucket: "day" | "week";
  step: 1 | 7;
  buckets: Array<{ start: string; end: string }>;
};

export function planBuckets(range: ReportRange): BucketPlan {
  const span = daysBetween(range.from, range.to) + 1;
  const step = span <= DAILY_BUCKET_MAX_DAYS ? 1 : 7;
  const buckets: BucketPlan["buckets"] = [];
  for (let offset = 0; offset < span; offset += step) {
    const end = Math.min(offset + step - 1, span - 1);
    buckets.push({ start: addDays(range.from, offset), end: addDays(range.from, end) });
  }
  return { bucket: step === 1 ? "day" : "week", step, buckets };
}

export type ReportEvents = {
  opportunitiesCreated: Date[];
  opportunitiesWon: Array<{ at: Date; amountCents: number }>;
  opportunitiesLost: Date[];
  tasksCompleted: Date[];
};
export type ReportBucket = {
  start: string;
  end: string;
  opportunitiesCreated: number;
  opportunitiesWon: number;
  opportunitiesLost: number;
  wonAmountCents: number;
  tasksCompleted: number;
};

/** The reference bucketing: the same events and range must give the same buckets as the SQL function. */
export function referenceBuckets(
  events: ReportEvents,
  range: ReportRange,
  timeZone: string,
): ReportBucket[] {
  const plan = planBuckets(range);
  const out: ReportBucket[] = plan.buckets.map((b) => ({
    ...b,
    opportunitiesCreated: 0,
    opportunitiesWon: 0,
    opportunitiesLost: 0,
    wonAmountCents: 0,
    tasksCompleted: 0,
  }));
  const slot = (at: Date) => {
    const offset = daysBetween(range.from, todayInZone(at, timeZone));
    if (offset < 0 || offset > daysBetween(range.from, range.to)) return null;
    return out[Math.floor(offset / plan.step)];
  };
  for (const at of events.opportunitiesCreated) {
    const b = slot(at);
    if (b) b.opportunitiesCreated += 1;
  }
  for (const won of events.opportunitiesWon) {
    const b = slot(won.at);
    if (b) {
      b.opportunitiesWon += 1;
      b.wonAmountCents += won.amountCents;
    }
  }
  for (const at of events.opportunitiesLost) {
    const b = slot(at);
    if (b) b.opportunitiesLost += 1;
  }
  for (const at of events.tasksCompleted) {
    const b = slot(at);
    if (b) b.tasksCompleted += 1;
  }
  return out;
}

/** What each number means, in words a business owner can read. `basis` says whether it is an event in the range or a snapshot of now. */
export const REPORT_METRICS = [
  {
    key: "opportunitiesCreated",
    label: "Opportunities created",
    basis: "event",
    description:
      "Deals added during each period, by the day they were created. Archived deals are not counted.",
  },
  {
    key: "opportunitiesWon",
    label: "Opportunities won",
    basis: "event",
    description:
      "Deals moved to Won during each period, by the day they were closed, with the value they were closed at.",
  },
  {
    key: "opportunitiesLost",
    label: "Opportunities lost",
    basis: "event",
    description: "Deals moved to Lost during each period, by the day they were closed.",
  },
  {
    key: "tasksCompleted",
    label: "Tasks completed",
    basis: "event",
    description: "Tasks marked done during each period, by the day they were completed.",
  },
  {
    key: "customersBySource",
    label: "New customers by source",
    basis: "event",
    description:
      "Customers added during the range, grouped by where they came from. Archived customers are not counted.",
  },
  {
    key: "opportunitiesByStage",
    label: "Deals by stage",
    basis: "current",
    description:
      "Where every unarchived deal stands right now. This is a snapshot of today, not of the selected range.",
  },
] as const;
