import { describe, expect, it } from "vitest";
import {
  addDays,
  dueState,
  InvalidTimeZoneError,
  isDueSoon,
  isIsoDate,
  isOverdue,
  todayInZone,
} from "./tasks";

const at = (iso: string) => new Date(iso);
const NY = "America/New_York";
const AKL = "Pacific/Auckland";

describe("isIsoDate", () => {
  it("accepts real calendar dates only", () => {
    for (const ok of ["2026-11-02", "2028-02-29", "2026-12-31", "0001-01-01"])
      expect(isIsoDate(ok), ok).toBe(true);
    for (const bad of [
      "2026-02-29",
      "2026-13-01",
      "2026-00-10",
      "2026-11-31",
      "2026-1-2",
      "2026-11-02T00:00:00Z",
      "",
      " 2026-11-02",
      null,
      undefined,
      20261102,
    ])
      expect(isIsoDate(bad), String(bad)).toBe(false);
  });
});

describe("todayInZone: the calendar date in the organization's zone", () => {
  it("differs by zone for the same instant", () => {
    const instant = at("2026-11-01T20:00:00Z");
    expect(todayInZone(instant, "UTC")).toBe("2026-11-01");
    expect(todayInZone(instant, NY)).toBe("2026-11-01"); // 15:00 EST
    expect(todayInZone(instant, AKL)).toBe("2026-11-02"); // 09:00 NZDT next day
  });

  it.each([
    // [zone, instant just before local midnight, instant at local midnight, date before, date after]
    ["UTC", "2026-06-15T23:59:59.999Z", "2026-06-16T00:00:00.000Z", "2026-06-15", "2026-06-16"],
    [NY, "2026-06-16T03:59:59.999Z", "2026-06-16T04:00:00.000Z", "2026-06-15", "2026-06-16"], // EDT, UTC-4
    [NY, "2026-01-16T04:59:59.999Z", "2026-01-16T05:00:00.000Z", "2026-01-15", "2026-01-16"], // EST, UTC-5
    [AKL, "2026-06-15T11:59:59.999Z", "2026-06-15T12:00:00.000Z", "2026-06-15", "2026-06-16"], // NZST, UTC+12
    [AKL, "2026-01-15T10:59:59.999Z", "2026-01-15T11:00:00.000Z", "2026-01-15", "2026-01-16"], // NZDT, UTC+13
    [
      "Asia/Kolkata",
      "2026-06-15T18:29:59.999Z",
      "2026-06-15T18:30:00.000Z",
      "2026-06-15",
      "2026-06-16",
    ], // +5:30
    [
      "Pacific/Kiritimati",
      "2026-06-15T09:59:59.999Z",
      "2026-06-15T10:00:00.000Z",
      "2026-06-15",
      "2026-06-16",
    ], // +14
    [
      "Pacific/Pago_Pago",
      "2026-06-16T10:59:59.999Z",
      "2026-06-16T11:00:00.000Z",
      "2026-06-15",
      "2026-06-16",
    ], // -11
  ])("%s rolls over at local midnight (%s -> %s)", (zone, before, after, dBefore, dAfter) => {
    expect(todayInZone(at(before), zone)).toBe(dBefore);
    expect(todayInZone(at(after), zone)).toBe(dAfter);
  });

  describe("DST", () => {
    it("New York spring forward (2026-03-08, a 23-hour day)", () => {
      expect(todayInZone(at("2026-03-08T04:59:59Z"), NY)).toBe("2026-03-07");
      expect(todayInZone(at("2026-03-08T05:00:00Z"), NY)).toBe("2026-03-08"); // midnight EST
      expect(todayInZone(at("2026-03-08T06:59:59Z"), NY)).toBe("2026-03-08"); // 01:59:59 EST
      expect(todayInZone(at("2026-03-08T07:00:00Z"), NY)).toBe("2026-03-08"); // 03:00 EDT, the skipped hour
      expect(todayInZone(at("2026-03-09T03:59:59Z"), NY)).toBe("2026-03-08"); // 23:59:59 EDT
      expect(todayInZone(at("2026-03-09T04:00:00Z"), NY)).toBe("2026-03-09"); // midnight EDT
    });
    it("New York fall back (2026-11-01, a 25-hour day): the repeated hour stays on the same date", () => {
      expect(todayInZone(at("2026-11-01T03:59:59Z"), NY)).toBe("2026-10-31");
      expect(todayInZone(at("2026-11-01T04:00:00Z"), NY)).toBe("2026-11-01"); // midnight EDT
      expect(todayInZone(at("2026-11-01T05:30:00Z"), NY)).toBe("2026-11-01"); // 01:30 EDT
      expect(todayInZone(at("2026-11-01T06:30:00Z"), NY)).toBe("2026-11-01"); // 01:30 EST (repeated hour)
      expect(todayInZone(at("2026-11-02T04:59:59Z"), NY)).toBe("2026-11-01"); // 23:59:59 EST
      expect(todayInZone(at("2026-11-02T05:00:00Z"), NY)).toBe("2026-11-02"); // midnight EST
    });
    it("Auckland spring forward (2026-09-27) and fall back (2026-04-05)", () => {
      expect(todayInZone(at("2026-09-26T11:59:59Z"), AKL)).toBe("2026-09-26");
      expect(todayInZone(at("2026-09-26T12:00:00Z"), AKL)).toBe("2026-09-27"); // midnight NZST
      expect(todayInZone(at("2026-09-27T10:59:59Z"), AKL)).toBe("2026-09-27"); // 23:59:59 NZDT
      expect(todayInZone(at("2026-09-27T11:00:00Z"), AKL)).toBe("2026-09-28");
      expect(todayInZone(at("2026-04-04T10:59:59Z"), AKL)).toBe("2026-04-04");
      expect(todayInZone(at("2026-04-04T11:00:00Z"), AKL)).toBe("2026-04-05"); // midnight NZDT
      expect(todayInZone(at("2026-04-05T11:59:59Z"), AKL)).toBe("2026-04-05"); // 23:59:59 NZST (25-hour day)
      expect(todayInZone(at("2026-04-05T12:00:00Z"), AKL)).toBe("2026-04-06");
    });
    it("a zone with no DST never shifts (UTC across the same weekends)", () => {
      expect(todayInZone(at("2026-03-08T07:00:00Z"), "UTC")).toBe("2026-03-08");
      expect(todayInZone(at("2026-11-01T06:30:00Z"), "UTC")).toBe("2026-11-01");
    });
  });

  it("rejects an invalid zone", () => {
    for (const bad of [
      "",
      "Mars/Phobos",
      "America/New York",
      "posix/UTC",
      "right/UTC",
      "EST",
      "utc",
      "Europe/Londn",
      "../etc",
      null,
      undefined,
      5,
    ]) {
      expect(() => todayInZone(at("2026-11-02T00:00:00Z"), bad as string), String(bad)).toThrow(
        InvalidTimeZoneError,
      );
    }
  });
  it("rejects an invalid instant", () => {
    expect(() => todayInZone(new Date("nope"), "UTC")).toThrow(RangeError);
  });
});

describe("addDays works on calendar dates", () => {
  it.each([
    ["2026-11-02", 7, "2026-11-09"],
    ["2026-12-28", 7, "2027-01-04"],
    ["2028-02-22", 7, "2028-02-29"], // leap day
    ["2027-02-22", 7, "2027-03-01"],
    ["2026-03-05", 7, "2026-03-12"], // across the US DST change: dates do not care
    ["2026-11-02", -2, "2026-10-31"],
    ["2026-11-02", 0, "2026-11-02"],
  ])("%s + %i = %s", (d, n, out) => expect(addDays(d, n)).toBe(out));
  it("rejects bad input", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
    expect(() => addDays("2026-11-02", 1.5)).toThrow(RangeError);
  });
});

const task = (dueDate: string | null, status = "open") => ({ dueDate, status });

describe("overdue", () => {
  const now = at("2026-11-02T15:00:00Z"); // Nov 2 in New York (10:00) and Auckland is Nov 3 (04:00)
  it("is due before today in the org zone; due today is not overdue; done is never overdue", () => {
    expect(isOverdue(task("2026-11-01"), now, NY)).toBe(true);
    expect(isOverdue(task("2026-11-02"), now, NY)).toBe(false);
    expect(isOverdue(task("2026-11-03"), now, NY)).toBe(false);
    expect(isOverdue(task("2026-11-01", "done"), now, NY)).toBe(false);
    expect(isOverdue(task("2026-11-01", "in_progress"), now, NY)).toBe(true);
  });
  it("depends on the ORG's zone, not the viewer's: the same instant and task differ by zone", () => {
    const t = task("2026-11-02");
    expect(isOverdue(t, now, NY)).toBe(false); // today in New York
    expect(isOverdue(t, now, AKL)).toBe(true); // already yesterday in Auckland
    expect(isOverdue(t, now, "UTC")).toBe(false);
  });
  it("flips exactly at local midnight, in three zones", () => {
    const t = task("2026-06-15");
    // UTC
    expect(isOverdue(t, at("2026-06-15T23:59:59Z"), "UTC")).toBe(false);
    expect(isOverdue(t, at("2026-06-16T00:00:00Z"), "UTC")).toBe(true);
    // New York (EDT)
    expect(isOverdue(t, at("2026-06-16T03:59:59Z"), NY)).toBe(false);
    expect(isOverdue(t, at("2026-06-16T04:00:00Z"), NY)).toBe(true);
    // Auckland (NZST)
    expect(isOverdue(t, at("2026-06-15T11:59:59Z"), AKL)).toBe(false);
    expect(isOverdue(t, at("2026-06-15T12:00:00Z"), AKL)).toBe(true);
  });
  it("on DST days it flips at the true local midnight (25-hour and 23-hour days)", () => {
    const fall = task("2026-11-01");
    expect(isOverdue(fall, at("2026-11-02T04:59:59Z"), NY)).toBe(false); // still Nov 1 (EST 23:59:59)
    expect(isOverdue(fall, at("2026-11-02T05:00:00Z"), NY)).toBe(true);
    const spring = task("2026-03-08");
    expect(isOverdue(spring, at("2026-03-09T03:59:59Z"), NY)).toBe(false);
    expect(isOverdue(spring, at("2026-03-09T04:00:00Z"), NY)).toBe(true);
  });
  it("a task with no date, or an invalid one, is not overdue", () => {
    expect(isOverdue(task(null), now, NY)).toBe(false);
    expect(isOverdue(task("2026-02-30"), now, NY)).toBe(false);
  });
  it("an invalid zone is refused, never silently UTC", () => {
    expect(() => isOverdue(task("2026-11-01"), now, "Mars/Phobos")).toThrow(InvalidTimeZoneError);
  });
});

describe("due soon: today through today + 7, both included", () => {
  const now = at("2026-11-02T15:00:00Z"); // today in New York: 2026-11-02
  it.each([
    ["2026-11-01", false], // yesterday: overdue, not due soon
    ["2026-11-02", true], // today
    ["2026-11-03", true],
    ["2026-11-09", true], // today + 7
    ["2026-11-10", false], // today + 8
    ["2027-01-01", false],
  ])("due %s -> %s", (due, expected) => {
    expect(isDueSoon(task(due), now, NY)).toBe(expected);
  });
  it("done, undated and invalid tasks are never due soon", () => {
    expect(isDueSoon(task("2026-11-03", "done"), now, NY)).toBe(false);
    expect(isDueSoon(task(null), now, NY)).toBe(false);
    expect(isDueSoon(task("garbage"), now, NY)).toBe(false);
  });
  it("crosses month, year and leap day", () => {
    expect(isDueSoon(task("2027-01-04"), at("2026-12-28T12:00:00Z"), "UTC")).toBe(true);
    expect(isDueSoon(task("2027-01-05"), at("2026-12-28T12:00:00Z"), "UTC")).toBe(false);
    expect(isDueSoon(task("2028-02-29"), at("2028-02-22T12:00:00Z"), "UTC")).toBe(true);
  });
  it("the window moves with the org's zone at local midnight", () => {
    // 2026-11-10 enters the window when the org's today becomes 2026-11-03
    expect(isDueSoon(task("2026-11-10"), at("2026-11-03T04:59:59Z"), NY)).toBe(false); // NY still Nov 2 (EST)
    expect(isDueSoon(task("2026-11-10"), at("2026-11-03T05:00:00Z"), NY)).toBe(true);
  });
  it("is mutually exclusive with overdue", () => {
    for (const due of ["2026-10-30", "2026-11-02", "2026-11-05", "2026-11-12"]) {
      const t = task(due);
      expect(isOverdue(t, now, NY) && isDueSoon(t, now, NY), due).toBe(false);
    }
  });
});

describe("dueState", () => {
  const now = at("2026-11-02T15:00:00Z");
  it("labels a task", () => {
    expect(dueState(task("2026-11-01"), now, NY)).toBe("overdue");
    expect(dueState(task("2026-11-02"), now, NY)).toBe("due_soon");
    expect(dueState(task("2026-11-30"), now, NY)).toBe("later");
    expect(dueState(task(null), now, NY)).toBe("none");
    expect(dueState(task("2026-11-01", "done"), now, NY)).toBe("done");
  });
  it("validates the zone even for done and undated tasks", () => {
    expect(() => dueState(task(null), now, "nope")).toThrow(InvalidTimeZoneError);
    expect(() => dueState(task("2026-11-01", "done"), now, "nope")).toThrow(InvalidTimeZoneError);
  });
});
