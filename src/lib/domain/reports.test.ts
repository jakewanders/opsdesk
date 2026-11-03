import { describe, expect, it } from "vitest";
import {
  daysBetween,
  planBuckets,
  referenceBuckets,
  resolveRange,
  validateRange,
  type ReportEvents,
} from "./reports";

const none: ReportEvents = {
  opportunitiesCreated: [],
  opportunitiesWon: [],
  opportunitiesLost: [],
  tasksCompleted: [],
};

describe("daysBetween", () => {
  it("counts calendar days, across a clock change and a leap day", () => {
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetween("2026-11-02", "2026-11-01")).toBe(-1);
  });
  it("refuses a non-date", () => expect(() => daysBetween("x", "2026-01-01")).toThrow(RangeError));
});

describe("resolveRange", () => {
  it("a preset ends today and covers that many days", () => {
    expect(resolveRange({ range: 7 }, "2026-11-02")).toEqual({
      from: "2026-10-27",
      to: "2026-11-02",
    });
    expect(resolveRange({}, "2026-11-02")).toEqual({ from: "2026-10-04", to: "2026-11-02" });
    expect(resolveRange({ range: 90 }, "2026-11-02")?.from).toBe("2026-08-05");
  });
  it("refuses other presets, mixtures, a lone date, a reversed range and more than 366 days", () => {
    expect(resolveRange({ range: 14 }, "2026-11-02")).toBeNull();
    expect(
      resolveRange({ range: 7, from: "2026-01-01", to: "2026-01-02" }, "2026-11-02"),
    ).toBeNull();
    expect(resolveRange({ from: "2026-01-01" }, "2026-11-02")).toBeNull();
    expect(resolveRange({ from: "2026-02-02", to: "2026-02-01" }, "2026-11-02")).toBeNull();
    expect(resolveRange({ from: "2026-01-01", to: "2027-01-02" }, "2026-11-02")).toBeNull();
  });
  it("accepts one day and exactly 366 days", () => {
    expect(validateRange({ from: "2026-05-05", to: "2026-05-05" })).not.toBeNull();
    expect(validateRange({ from: "2026-01-01", to: "2027-01-01" })).not.toBeNull();
  });
});

describe("planBuckets", () => {
  it("is daily up to 31 days and weekly beyond, every bucket present", () => {
    const daily = planBuckets({ from: "2026-10-01", to: "2026-10-31" });
    expect(daily.bucket).toBe("day");
    expect(daily.buckets).toHaveLength(31);
    const weekly = planBuckets({ from: "2026-10-01", to: "2026-11-01" });
    expect(weekly.bucket).toBe("week");
    expect(weekly.buckets).toHaveLength(5);
    expect(weekly.buckets[0]).toEqual({ start: "2026-10-01", end: "2026-10-07" });
    expect(weekly.buckets[4]).toEqual({ start: "2026-10-29", end: "2026-11-01" });
  });
});

describe("referenceBuckets", () => {
  it("puts an event on its LOCAL date: 23:30 in New York is already the next day in UTC", () => {
    const events = { ...none, tasksCompleted: [new Date("2026-03-09T03:30:00Z")] }; // 23:30 on the 8th in New York (EDT)
    const b = referenceBuckets(
      events,
      { from: "2026-03-07", to: "2026-03-10" },
      "America/New_York",
    );
    expect(b.map((x) => x.tasksCompleted)).toEqual([0, 1, 0, 0]);
  });
  it("keeps both ends of a range inclusive and drops events outside", () => {
    const events = {
      ...none,
      opportunitiesCreated: [
        new Date("2026-03-07T04:59:59Z"), // 23:59:59 on the 6th in New York: out
        new Date("2026-03-07T05:00:00Z"), // 00:00 on the 7th: in
        new Date("2026-03-09T03:59:59Z"), // 23:59:59 on the 8th: in
        new Date("2026-03-09T04:00:00Z"), // 00:00 on the 9th: out
      ],
    };
    const b = referenceBuckets(
      events,
      { from: "2026-03-07", to: "2026-03-08" },
      "America/New_York",
    );
    expect(b.map((x) => x.opportunitiesCreated)).toEqual([1, 1]);
  });
  it("a 23-hour spring-forward day is still one bucket", () => {
    const events = {
      ...none,
      opportunitiesLost: [new Date("2026-03-08T05:00:00Z"), new Date("2026-03-09T03:59:00Z")],
    };
    const b = referenceBuckets(
      events,
      { from: "2026-03-08", to: "2026-03-08" },
      "America/New_York",
    );
    expect(b).toHaveLength(1);
    expect(b[0].opportunitiesLost).toBe(2);
  });
  it("sums won amounts and groups a long range by week", () => {
    const events = {
      ...none,
      opportunitiesWon: [
        { at: new Date("2026-10-02T12:00:00Z"), amountCents: 1000 },
        { at: new Date("2026-10-09T12:00:00Z"), amountCents: 250 },
        { at: new Date("2026-10-10T12:00:00Z"), amountCents: 5 },
      ],
    };
    const b = referenceBuckets(events, { from: "2026-10-01", to: "2026-11-05" }, "UTC");
    expect(b.map((x) => [x.opportunitiesWon, x.wonAmountCents])).toEqual([
      [1, 1000],
      [2, 255],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });
});
