import { afterEach, describe, expect, it, vi } from "vitest";
import { addDays, todayInZone } from "@/lib/domain/tasks";
import { taskListQuery, toTaskDto, type TaskRow } from "./schema";

const repo = vi.hoisted(() => ({ listTasks: vi.fn() }));
vi.mock("./repository", async (orig) => ({
  ...(await orig<typeof import("./repository")>()),
  ...repo,
}));
const { listForOrg } = await import("./service");

/**
 * [SIT-253] The overdue and due-today rules through the API layer, with a FIXED clock, around local midnight and across
 * daylight-saving changes in zones with unusual offsets. The instants and the dates they fall on are written out by hand
 * (not computed by the code under test), so a change to the zone handling shows up as a named row going red.
 *
 * (src/lib/domain/tasks.test.ts covers the pure rules; this covers what the endpoints do with them: the `today` that the
 *  overdue filter receives and the `dueState` / `dueToday` flags on each task.)
 */
const ROWS: Array<[zone: string, instant: string, localDate: string, why: string]> = [
  // New York: spring forward 2026-03-08 07:00Z (a 23-hour day), fall back 2026-11-01 06:00Z (a 25-hour day)
  [
    "America/New_York",
    "2026-03-09T03:59:59Z",
    "2026-03-08",
    "23:59:59 EDT, the last second of the short day",
  ],
  [
    "America/New_York",
    "2026-03-09T04:00:00Z",
    "2026-03-09",
    "00:00:00 EDT, the first second after it",
  ],
  ["America/New_York", "2026-11-01T04:00:00Z", "2026-11-01", "00:00:00 EDT, start of the long day"],
  [
    "America/New_York",
    "2026-11-01T05:59:59Z",
    "2026-11-01",
    "01:59:59 EDT, just before the clocks go back",
  ],
  [
    "America/New_York",
    "2026-11-01T06:00:00Z",
    "2026-11-01",
    "01:00:00 EST, the repeated hour stays on the same date",
  ],
  [
    "America/New_York",
    "2026-11-02T04:59:59Z",
    "2026-11-01",
    "23:59:59 EST, the last second of the long day",
  ],
  [
    "America/New_York",
    "2026-11-02T05:00:00Z",
    "2026-11-02",
    "00:00:00 EST, the first second after it",
  ],
  // London: BST ends 2026-10-25 01:00Z
  ["Europe/London", "2026-10-24T22:59:59Z", "2026-10-24", "23:59:59 BST"],
  ["Europe/London", "2026-10-24T23:00:00Z", "2026-10-25", "00:00:00 BST, start of the 25-hour day"],
  ["Europe/London", "2026-10-25T23:59:59Z", "2026-10-25", "23:59:59 GMT"],
  ["Europe/London", "2026-10-26T00:00:00Z", "2026-10-26", "00:00:00 GMT"],
  // Lord Howe: a 30-minute DST shift; +11:00 until 2026-04-04T15:00Z, then +10:30
  ["Australia/Lord_Howe", "2026-04-04T12:59:59Z", "2026-04-04", "23:59:59 at +11:00"],
  ["Australia/Lord_Howe", "2026-04-04T13:00:00Z", "2026-04-05", "00:00:00 at +11:00"],
  ["Australia/Lord_Howe", "2026-04-05T13:29:59Z", "2026-04-05", "23:59:59 at +10:30"],
  ["Australia/Lord_Howe", "2026-04-05T13:30:00Z", "2026-04-06", "00:00:00 at +10:30"],
  // half-hour and far-from-UTC zones
  ["Asia/Kolkata", "2026-11-02T18:29:59Z", "2026-11-02", "23:59:59 at +5:30"],
  ["Asia/Kolkata", "2026-11-02T18:30:00Z", "2026-11-03", "00:00:00 at +5:30"],
  ["Pacific/Kiritimati", "2026-11-02T09:59:59Z", "2026-11-02", "23:59:59 at +14:00"],
  ["Pacific/Kiritimati", "2026-11-02T10:00:00Z", "2026-11-03", "00:00:00 at +14:00"],
  ["Pacific/Apia", "2026-11-02T10:59:59Z", "2026-11-02", "23:59:59 at +13:00"],
  ["Pacific/Apia", "2026-11-02T11:00:00Z", "2026-11-03", "00:00:00 at +13:00"],
  ["Pacific/Pago_Pago", "2026-11-02T10:59:59Z", "2026-11-01", "23:59:59 at -11:00"],
  ["Pacific/Pago_Pago", "2026-11-02T11:00:00Z", "2026-11-02", "00:00:00 at -11:00"],
  ["UTC", "2026-11-02T23:59:59Z", "2026-11-02", "UTC, the last second of the day"],
  ["UTC", "2026-11-03T00:00:00Z", "2026-11-03", "UTC, the first second after it"],
];

const row = (due: string | null, status = "todo"): TaskRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  title: "Clocked",
  description: null,
  status,
  priority: "medium",
  due_date: due,
  assigned_to: null,
  customer_id: null,
  opportunity_id: null,
  completed_at: null,
  created_by: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  archived_at: null,
});

afterEach(() => vi.useRealTimers());

describe("the local date at a fixed instant (hand-written expectations)", () => {
  it.each(ROWS)("%s at %s is %s (%s)", (zone, instant, localDate) => {
    expect(todayInZone(new Date(instant), zone)).toBe(localDate);
  });
});

describe("task flags at a fixed instant: yesterday overdue, today due-today (never overdue), tomorrow neither, done never", () => {
  it.each(ROWS)("%s at %s", (zone, instant, localDate) => {
    const now = new Date(instant);
    const flags = (due: string, status = "todo") => {
      const t = toTaskDto(row(due, status), zone, now);
      return `${t.dueState}/${t.dueToday}`;
    };
    expect(flags(addDays(localDate, -1))).toBe("overdue/false");
    expect(flags(addDays(localDate, -30))).toBe("overdue/false");
    expect(flags(localDate)).toBe("due_soon/true");
    expect(flags(addDays(localDate, 1))).toBe("due_soon/false");
    expect(flags(addDays(localDate, 7))).toBe("due_soon/false");
    expect(flags(addDays(localDate, 8))).toBe("later/false");
    expect(flags(addDays(localDate, -1), "done")).toBe("done/false");
    expect(flags(localDate, "done")).toBe("done/false");
    expect(toTaskDto(row(null), zone, now)).toMatchObject({ dueState: "none", dueToday: false });
  });
});

describe("the overdue filter receives the organization's today, from the clock at request time", () => {
  const ctx = (timezone: string) =>
    ({
      role: "member",
      kind: "real",
      org: { id: "org-1", timezone },
      user: { id: "user-1" },
    }) as never;
  it.each(ROWS)("%s at %s: today = %s", async (zone, instant, localDate) => {
    repo.listTasks.mockReset();
    repo.listTasks.mockResolvedValue({ items: [], meta: {} });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(instant));
    await listForOrg({} as never, ctx(zone), taskListQuery.parse({ overdue: "true" }));
    expect(repo.listTasks).toHaveBeenCalledWith(
      {} as never,
      { orgId: "org-1", userId: "user-1", today: localDate },
      zone,
      expect.anything(),
    );
  });
  it("the same instant gives different filters for two organizations in different zones", async () => {
    repo.listTasks.mockReset();
    repo.listTasks.mockResolvedValue({ items: [], meta: {} });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T11:00:00Z"));
    await listForOrg({} as never, ctx("Pacific/Pago_Pago"), taskListQuery.parse({}));
    await listForOrg({} as never, ctx("Pacific/Kiritimati"), taskListQuery.parse({}));
    const todays = repo.listTasks.mock.calls.map((c) => c[1].today);
    expect(todays).toEqual(["2026-11-02", "2026-11-03"]);
  });
});
