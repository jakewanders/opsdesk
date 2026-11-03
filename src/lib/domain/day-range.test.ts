import { describe, expect, it } from "vitest";
import { dayRangeBounds, zonedDayStart } from "./day-range";

describe("zonedDayStart", () => {
  it("is midnight UTC in UTC", () => {
    expect(zonedDayStart("2026-11-02", "UTC").toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });
  it("follows the zone's offset, east and west of UTC", () => {
    expect(zonedDayStart("2026-11-02", "America/New_York").toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    ); // EST, UTC-5
    expect(zonedDayStart("2026-07-02", "America/New_York").toISOString()).toBe(
      "2026-07-02T04:00:00.000Z",
    ); // EDT, UTC-4
    expect(zonedDayStart("2026-11-02", "Asia/Tokyo").toISOString()).toBe(
      "2026-11-01T15:00:00.000Z",
    ); // UTC+9
    expect(zonedDayStart("2026-11-02", "Pacific/Kiritimati").toISOString()).toBe(
      "2026-11-01T10:00:00.000Z",
    ); // UTC+14
    expect(zonedDayStart("2026-11-02", "Pacific/Pago_Pago").toISOString()).toBe(
      "2026-11-02T11:00:00.000Z",
    ); // UTC-11
    expect(zonedDayStart("2026-11-02", "Asia/Kolkata").toISOString()).toBe(
      "2026-11-01T18:30:00.000Z",
    ); // UTC+5:30
  });
  it("is right on the days the clocks change", () => {
    // US spring forward 2026-03-08 (a 23-hour day) and fall back 2026-11-01 (a 25-hour day)
    expect(zonedDayStart("2026-03-08", "America/New_York").toISOString()).toBe(
      "2026-03-08T05:00:00.000Z",
    );
    expect(zonedDayStart("2026-03-09", "America/New_York").toISOString()).toBe(
      "2026-03-09T04:00:00.000Z",
    );
    expect(zonedDayStart("2026-11-01", "America/New_York").toISOString()).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    expect(zonedDayStart("2026-11-02", "America/New_York").toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
  });
  it("refuses a bad date or zone", () => {
    expect(() => zonedDayStart("2026-02-30", "UTC")).toThrow(RangeError);
    expect(() => zonedDayStart("2026-02-01", "Mars/Base")).toThrow(RangeError);
  });
});

describe("dayRangeBounds", () => {
  it("includes both end days: from the start of `from` up to (not including) the start of the day after `to`", () => {
    expect(dayRangeBounds({ from: "2026-11-01", to: "2026-11-02" }, "America/New_York")).toEqual({
      gte: "2026-11-01T04:00:00.000Z",
      lt: "2026-11-03T05:00:00.000Z",
    });
  });
  it("a one-day range across a 25-hour day is 25 hours long", () => {
    const r = dayRangeBounds({ from: "2026-11-01", to: "2026-11-01" }, "America/New_York");
    expect((Date.parse(r.lt!) - Date.parse(r.gte!)) / 3_600_000).toBe(25);
  });
  it("a one-day range across a 23-hour day is 23 hours long", () => {
    const r = dayRangeBounds({ from: "2026-03-08", to: "2026-03-08" }, "America/New_York");
    expect((Date.parse(r.lt!) - Date.parse(r.gte!)) / 3_600_000).toBe(23);
  });
  it("open ends stay open", () => {
    expect(dayRangeBounds({ from: "2026-11-01" }, "UTC")).toEqual({
      gte: "2026-11-01T00:00:00.000Z",
    });
    expect(dayRangeBounds({ to: "2026-11-01" }, "UTC")).toEqual({ lt: "2026-11-02T00:00:00.000Z" });
    expect(dayRangeBounds({}, "UTC")).toEqual({});
  });
});
