import { describe, expect, it } from "vitest";
import { buildUsageReport, dayRange, formatUsageReport, rate, type UsageRow } from "./report";

const TODAY = new Date("2026-11-03T15:00:00Z");

describe("dayRange [P-03]", () => {
  it("is the last N UTC days ending today, oldest first", () => {
    expect(dayRange(3, TODAY)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
  });
  it("crosses a month and a year boundary", () => {
    expect(dayRange(3, new Date("2027-01-01T00:00:00Z"))).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
    ]);
  });
});

describe("rate", () => {
  it("rounds to a whole percent and is null when nothing started", () => {
    expect(rate(1, 3)).toBe(33);
    expect(rate(2, 3)).toBe(67);
    expect(rate(0, 0)).toBeNull();
  });
});

describe("buildUsageReport [P-03]", () => {
  const rows: UsageRow[] = [
    { day: "2026-11-02", metric: "demos_started", total: 4 },
    { day: "2026-11-02", metric: "demos_with_customer_created", total: "2" }, // bigint may arrive as a string
    { day: "2026-11-02", metric: "demos_expired_unused", total: 1 },
    { day: "2026-11-03", metric: "demos_started", total: 2 },
    { day: "2026-11-03", metric: "demos_in_progress", total: 2 },
    { day: "2026-11-03", metric: "demos_with_quote_created", total: 1 },
    { day: "2026-11-03", metric: "real_accounts_created", total: 1 },
    { day: "2026-10-01", metric: "demos_started", total: 99 }, // outside the window: ignored
    { day: "2026-11-03", metric: "something_new", total: 5 }, // unknown metric: ignored
  ];
  const report = buildUsageReport(rows, 3, TODAY);

  it("lists every day in the window, with zeros for days without rows", () => {
    expect(report.days.map((d) => d.day)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(report.days[0].demos_started).toBe(0);
    expect(report.days[1].demos_with_customer_created).toBe(2);
  });
  it("sums the totals and ignores rows outside the window and unknown metrics", () => {
    expect(report.totals.demos_started).toBe(6);
    expect(report.totals.demos_with_customer_created).toBe(2);
    expect(report.totals.demos_in_progress).toBe(2);
    expect(report.totals.real_accounts_created).toBe(1);
  });
  it("derives rates as a percent of demos started", () => {
    expect(report.rates.demos_with_customer_created).toBe(33);
    expect(report.rates.demos_with_quote_created).toBe(17);
    expect(report.rates.demos_expired_unused).toBe(17);
    expect(report.rates.demos_with_stage_move).toBe(0);
  });
  it("has no rate when no demo started", () => {
    expect(buildUsageReport([], 2, TODAY).rates.demos_reset).toBeNull();
  });
});

describe("formatUsageReport", () => {
  const text = formatUsageReport(
    buildUsageReport([{ day: "2026-11-03", metric: "demos_started", total: 3 }], 2, TODAY),
  );
  it("prints a header, a row per day, the totals and the rates", () => {
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^day \(UTC\)\s+started\s+running/);
    expect(lines.some((l) => l.startsWith("2026-11-02"))).toBe(true);
    expect(lines.some((l) => /^2026-11-03\s+3\s/.test(l))).toBe(true);
    expect(lines.some((l) => /^total\s+3\s/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/^% started\s+0%\s+0%/);
  });
  it("contains only counts, percentages and dates", () => {
    expect(
      text
        .replace(/[-0-9%\s]/g, "")
        .replace(
          /day\(UTC\)|started|running|customer|stage|task|quote|reset|unused|signups|total/g,
          "",
        ),
    ).toBe("");
  });
});
