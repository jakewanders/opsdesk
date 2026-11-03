import { addDays, isIsoDate } from "./tasks";
import { isIanaTimeZone } from "./timezone";

/**
 * Calendar days to instants, in the ORGANIZATION's time zone (the same "organization time" as overdue and the dashboard): "created
 * from 2026-03-08 to 2026-03-09" means from the start of the 8th to the end of the 9th where the workspace is, not in UTC. A day can
 * be 23 or 25 hours long where the clocks change, so the end of a range is the START of the next day (an exclusive bound), never
 * "23:59:59".
 */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const localAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return localAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant the calendar day `date` (`YYYY-MM-DD`) begins in `timeZone`. */
export function zonedDayStart(date: string, timeZone: string): Date {
  if (!isIsoDate(date)) throw new RangeError(`"${date}" is not a YYYY-MM-DD date`);
  if (!isIanaTimeZone(timeZone)) throw new RangeError(`"${timeZone}" is not a time zone`);
  const [y, m, d] = date.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d);
  // the offset is read at the guess, then again at the corrected instant, which settles it across a clock change
  let t = naive - offsetMs(new Date(naive), timeZone);
  t = naive - offsetMs(new Date(t), timeZone);
  return new Date(t);
}

/** `from` and `to` are inclusive days; the result is `gte` (start of `from`) and `lt` (start of the day after `to`), as ISO instants. */
export function dayRangeBounds(
  range: { from?: string | null; to?: string | null },
  timeZone: string,
): { gte?: string; lt?: string } {
  const out: { gte?: string; lt?: string } = {};
  if (range.from) out.gte = zonedDayStart(range.from, timeZone).toISOString();
  if (range.to) out.lt = zonedDayStart(addDays(range.to, 1), timeZone).toISOString();
  return out;
}
