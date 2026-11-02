import { isIanaTimeZone } from "./timezone";

/**
 * "Overdue" and "due soon" for tasks (PRD US-05, US-06, 11.1): the ONE implementation, used by the API, the task list,
 * the dashboard and the reports.
 *
 * A task's `due_date` is a calendar DATE with no time and no zone ("2026-03-09"). "Today" is the calendar date it is
 * right now in the ORGANIZATION's time zone, not the browser's and not UTC. So:
 *
 * - **overdue**: `due_date` is before today (org zone) and the task is not done. A task due today is not overdue.
 * - **due soon**: `due_date` is from today through today + 7 days, both ends included, and the task is not done.
 *
 * The same rule is written in SQL for the dashboard as `(now() at time zone tz)::date`; the integration test
 * `tasks.integration.test.ts` runs both against the real database and requires them to agree, across zones and DST.
 */

export const DUE_SOON_DAYS = 7;

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";

/** What a task needs for these rules. */
export type DueInput = { dueDate: string | null; status: TaskStatus | string };

export type DueState = "none" | "done" | "overdue" | "due_soon" | "later";

/** `Date.UTC` treats years 0 to 99 as 1900 to 1999; this does not. */
function utcDate(year: number, month: number, day: number): Date {
  const d = new Date(0);
  d.setUTCFullYear(year, month, day);
  return d;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written `YYYY-MM-DD` (no "2026-02-30", no times). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = utcDate(y, mo - 1, d);
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

export class InvalidTimeZoneError extends Error {
  constructor(timeZone: unknown) {
    super(
      `"${String(timeZone)}" is not a valid IANA time zone (for example America/New_York, or UTC).`,
    );
    this.name = "InvalidTimeZoneError";
  }
}

function assertZone(timeZone: string): void {
  if (typeof timeZone !== "string" || !isIanaTimeZone(timeZone))
    throw new InvalidTimeZoneError(timeZone);
}

/** The calendar date (`YYYY-MM-DD`) it is at `instant` in `timeZone`. */
export function todayInZone(instant: Date, timeZone: string): string {
  assertZone(timeZone);
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime()))
    throw new RangeError("Invalid instant");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** `date` plus whole `days` (negative allowed), as a calendar date: no clock, so DST cannot move it. */
export function addDays(date: string, days: number): string {
  if (!isIsoDate(date)) throw new RangeError(`"${date}" is not a YYYY-MM-DD date`);
  if (!Number.isInteger(days)) throw new RangeError("days must be a whole number");
  const [y, m, d] = date.split("-").map(Number);
  const out = utcDate(y, m - 1, d + days);
  return out.toISOString().slice(0, 10);
}

/** ISO date strings of the same shape compare correctly as plain strings. */
const before = (a: string, b: string) => a < b;

function pending(task: DueInput): task is DueInput & { dueDate: string } {
  return task.status !== "done" && task.dueDate !== null && isIsoDate(task.dueDate);
}

/** Not done, and due before today in the organization's zone. A task due today is NOT overdue. */
export function isOverdue(task: DueInput, now: Date, timeZone: string): boolean {
  const today = todayInZone(now, timeZone);
  return pending(task) && before(task.dueDate, today);
}

/** Not done, and due from today through today + 7 days (both included) in the organization's zone. */
export function isDueSoon(task: DueInput, now: Date, timeZone: string): boolean {
  const today = todayInZone(now, timeZone);
  if (!pending(task)) return false;
  return !before(task.dueDate, today) && !before(addDays(today, DUE_SOON_DAYS), task.dueDate);
}

/** One label for a task, for list badges and groupings. */
export function dueState(task: DueInput, now: Date, timeZone: string): DueState {
  assertZone(timeZone); // an invalid zone is an error whatever the task looks like
  if (task.status === "done") return "done";
  if (task.dueDate === null || !isIsoDate(task.dueDate)) return "none";
  if (isOverdue(task, now, timeZone)) return "overdue";
  if (isDueSoon(task, now, timeZone)) return "due_soon";
  return "later";
}
