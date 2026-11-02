import { describe, expect, it } from "vitest";
import { daysFromToday, relativeDay } from "./relative-day";

describe("relativeDay [SIT-255]", () => {
  const today = "2026-11-02";
  it.each([
    ["2026-11-02", "Today"],
    ["2026-11-03", "Tomorrow"],
    ["2026-11-01", "Yesterday"],
    ["2026-11-09", "In 7 days"],
    ["2026-10-28", "5 days ago"],
    ["2027-01-01", "In 60 days"],
  ])("%s is %s", (date, words) => expect(relativeDay(date, today)).toBe(words));
  it("counts calendar days across a DST change and a year end", () => {
    expect(daysFromToday("2026-11-02", "2026-11-01")).toBe(1); // US clocks fall back on 2026-11-01
    expect(daysFromToday("2026-03-09", "2026-03-08")).toBe(1);
    expect(daysFromToday("2027-01-01", "2026-12-31")).toBe(1);
    expect(daysFromToday("2024-03-01", "2024-02-28")).toBe(2); // leap year
  });
});
