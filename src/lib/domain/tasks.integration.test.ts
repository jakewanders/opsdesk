import { describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { addDays, isDueSoon, isOverdue, todayInZone } from "./tasks";

/**
 * Parity (SIT-173): the TypeScript rules and the SQL the dashboard uses must agree. Both are run over the same
 * instants, every 30 minutes across the DST changes of New York and Auckland plus ordinary days, in eight zones.
 *
 *   today    = (ts at time zone tz)::date
 *   overdue  = due_date <  today and status <> 'done'
 *   due soon = due_date between today and today + 7 and status <> 'done'
 */
const ZONES = [
  "UTC",
  "America/New_York",
  "Pacific/Auckland",
  "Asia/Kolkata",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
  "Europe/London",
  "Australia/Lord_Howe", // a 30-minute DST shift
];
const WINDOWS: Array<[string, string]> = [
  ["2026-03-07T00:00:00Z", "2026-03-10T00:00:00Z"], // US spring forward
  ["2026-10-31T00:00:00Z", "2026-11-03T00:00:00Z"], // US fall back
  ["2026-09-26T00:00:00Z", "2026-09-29T00:00:00Z"], // NZ spring forward
  ["2026-04-04T00:00:00Z", "2026-04-07T00:00:00Z"], // NZ fall back
  ["2026-03-28T00:00:00Z", "2026-03-30T00:00:00Z"], // Europe spring forward
  ["2026-10-03T00:00:00Z", "2026-10-06T00:00:00Z"], // Lord Howe spring forward (30 minutes)
  ["2028-02-27T00:00:00Z", "2028-03-02T00:00:00Z"], // a leap day
  ["2026-12-29T00:00:00Z", "2027-01-03T00:00:00Z"], // year end
];
const OFFSETS = Array.from({ length: 12 }, (_, i) => i - 2); // due = today - 2 ... today + 9

function sqlRows(): Array<{
  tz: string;
  ts: string;
  today: string;
  overdue: string;
  soon: string;
}> {
  const windows = WINDOWS.map(
    ([a, b]) =>
      `select generate_series('${a}'::timestamptz, '${b}'::timestamptz, interval '30 minutes') ts`,
  ).join(" union all ");
  const zones = ZONES.map((z) => `('${z}')`).join(",");
  const out = psql(`
    with instants as (${windows}), zones(tz) as (values ${zones}),
    base as (select z.tz, i.ts, (i.ts at time zone z.tz)::date as today from instants i cross join zones z)
    select tz || '|' || to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '|' || today::text || '|' ||
      (select string_agg(case when (today + o) < today then '1' else '0' end, '' order by o) from generate_series(-2, 9) o) || '|' ||
      (select string_agg(case when (today + o) between today and today + 7 then '1' else '0' end, '' order by o) from generate_series(-2, 9) o)
    from base order by tz, ts;
  `);
  return out.split("\n").map((line) => {
    const [tz, ts, today, overdue, soon] = line.split("|");
    return { tz, ts, today, overdue, soon };
  });
}

describe("TypeScript and SQL agree on today, overdue and due soon", () => {
  const rows = sqlRows();

  it("covers every zone across the whole range", () => {
    expect(rows.length).toBeGreaterThan(ZONES.length * 500);
    expect(new Set(rows.map((r) => r.tz)).size).toBe(ZONES.length);
  });

  it("todayInZone equals (ts at time zone tz)::date for every instant and zone", () => {
    const mismatches = rows
      .filter((r) => todayInZone(new Date(r.ts), r.tz) !== r.today)
      .map((r) => `${r.tz} ${r.ts}`);
    expect(mismatches).toEqual([]);
  });

  it("overdue and due soon agree for due dates from two days ago to nine days ahead", () => {
    const mismatches: string[] = [];
    for (const r of rows) {
      const now = new Date(r.ts);
      OFFSETS.forEach((off, i) => {
        const task = { dueDate: addDays(r.today, off), status: "todo" };
        if ((isOverdue(task, now, r.tz) ? "1" : "0") !== r.overdue[i])
          mismatches.push(`overdue ${r.tz} ${r.ts} ${off}`);
        if ((isDueSoon(task, now, r.tz) ? "1" : "0") !== r.soon[i])
          mismatches.push(`soon ${r.tz} ${r.ts} ${off}`);
      });
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
  });

  it("the rules were really exercised: both overdue and due-soon cases occur, and today moves in every zone", () => {
    expect(rows.some((r) => r.overdue.includes("1"))).toBe(true);
    expect(rows.some((r) => r.soon.includes("1"))).toBe(true);
    for (const tz of ZONES)
      expect(new Set(rows.filter((r) => r.tz === tz).map((r) => r.today)).size).toBeGreaterThan(2);
  });
});
