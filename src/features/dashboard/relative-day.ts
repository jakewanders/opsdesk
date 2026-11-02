const DAY_MS = 86_400_000;
const utc = (date: string) =>
  Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));

/** Whole calendar days from `today` to `date` (negative = in the past). Dates only, so no time zone or DST can shift it. */
export function daysFromToday(date: string, today: string): number {
  return Math.round((utc(date) - utc(today)) / DAY_MS);
}

/**
 * A due date in words, relative to the organization's `today`: "Today", "Tomorrow", "In 3 days", "Yesterday",
 * "5 days ago". Pair it with the real date (a `<time>` with the full date as its title), never use it alone.
 */
export function relativeDay(date: string, today: string): string {
  const n = daysFromToday(date, today);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  return n > 0 ? `In ${n} days` : `${-n} days ago`;
}
