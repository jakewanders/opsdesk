import { describe, expect, it } from "vitest";
import { parseUrlState, serializeUrlState } from "@/lib/api-client/url-state";
import type { ReportBucket } from "@/lib/domain/reports";
import {
  bucketLabel,
  customRangeProblem,
  eventTotals,
  formatRange,
  reportUrl,
  toApiQuery,
  trendRows,
  winRate,
  workspaceStartedAfter,
} from "./report-data";

const bucket = (o: Partial<ReportBucket> = {}): ReportBucket => ({
  start: "2026-10-03",
  end: "2026-10-03",
  opportunitiesCreated: 0,
  opportunitiesWon: 0,
  opportunitiesLost: 0,
  wonAmountCents: 0,
  tasksCompleted: 0,
  ...o,
});

describe("URL state", () => {
  it("the default view has a clean URL and round trips", () => {
    const state = parseUrlState(reportUrl, new URLSearchParams(""));
    expect(state).toEqual({ range: "30", from: "", to: "" });
    expect(serializeUrlState(reportUrl, state)).toBe("");
    const custom = { range: "custom", from: "2026-03-01", to: "2026-03-31" };
    expect(
      parseUrlState(reportUrl, new URLSearchParams(serializeUrlState(reportUrl, custom))),
    ).toEqual(custom);
  });
  it("an unknown range falls back to 30 days", () => {
    expect(parseUrlState(reportUrl, new URLSearchParams("range=14")).range).toBe("30");
  });
});

describe("toApiQuery", () => {
  it("presets send range; a valid custom range sends from and to", () => {
    expect(toApiQuery({ range: "7", from: "", to: "" })).toEqual({ range: 7 });
    expect(toApiQuery({ range: "custom", from: "2026-03-01", to: "2026-03-31" })).toEqual({
      from: "2026-03-01",
      to: "2026-03-31",
    });
  });
  it("a custom range that cannot be used falls back to the server default", () => {
    expect(toApiQuery({ range: "custom", from: "", to: "" })).toEqual({});
    expect(toApiQuery({ range: "custom", from: "2026-03-10", to: "2026-03-01" })).toEqual({});
  });
});

describe("customRangeProblem", () => {
  it("says what is wrong in words, or null", () => {
    expect(customRangeProblem("", "2026-01-01")).toBe("Choose both a start and an end date.");
    expect(customRangeProblem("2026-02-30", "2026-03-01")).toBe(
      "Choose both a start and an end date.",
    );
    expect(customRangeProblem("2026-03-10", "2026-03-09")).toBe(
      "The end date is before the start date.",
    );
    expect(customRangeProblem("2026-01-01", "2027-01-02")).toBe("Choose at most 366 days.");
    expect(customRangeProblem("2026-01-01", "2027-01-01")).toBeNull();
    expect(customRangeProblem("2026-05-05", "2026-05-05")).toBeNull();
  });
});

describe("formatRange", () => {
  it("shows the exact range with the year once and the zone always", () => {
    expect(formatRange("2026-10-03", "2026-11-01", "America/New_York")).toBe(
      "Oct 3 to Nov 1, 2026, America/New_York",
    );
  });
  it("shows both years when the range crosses New Year, and one date for one day", () => {
    expect(formatRange("2025-12-20", "2026-01-09", "UTC")).toBe("Dec 20, 2025 to Jan 9, 2026, UTC");
    expect(formatRange("2026-03-08", "2026-03-08", "UTC")).toBe("Mar 8, 2026, UTC");
  });
});

describe("buckets", () => {
  it("labels a day and a week", () => {
    expect(bucketLabel({ start: "2026-10-03", end: "2026-10-03" })).toBe("Oct 3");
    expect(bucketLabel({ start: "2026-10-03", end: "2026-10-09" })).toBe("Oct 3 to Oct 9");
  });
  it("maps the API's buckets without changing a number", () => {
    const rows = trendRows([
      bucket({
        opportunitiesCreated: 2,
        opportunitiesWon: 1,
        opportunitiesLost: 3,
        tasksCompleted: 4,
      }),
    ]);
    expect(rows).toEqual([{ label: "Oct 3", created: 2, won: 1, lost: 3, completed: 4 }]);
  });
  it("sums totals", () => {
    const t = eventTotals([
      bucket({ opportunitiesCreated: 2, tasksCompleted: 1 }),
      bucket({ opportunitiesCreated: 1, opportunitiesWon: 2 }),
    ]);
    expect(t).toEqual({ created: 3, won: 2, lost: 0, completed: 1 });
  });
});

describe("winRate", () => {
  it("is wins over closed deals, rounded, and absent when nothing closed", () => {
    expect(winRate([bucket()])).toBeNull();
    expect(winRate([bucket({ opportunitiesWon: 1, opportunitiesLost: 2 })])).toEqual({
      won: 1,
      closed: 3,
      percent: 33,
    });
    expect(winRate([bucket({ opportunitiesWon: 2, opportunitiesLost: 1 })])?.percent).toBe(67);
    expect(winRate([bucket({ opportunitiesWon: 5 })])?.percent).toBe(100);
  });
});

describe("workspaceStartedAfter", () => {
  it("names the creation day (in the workspace's zone) when the range starts earlier", () => {
    expect(workspaceStartedAfter("2026-10-01", "2026-10-15T03:00:00Z", "America/New_York")).toBe(
      "2026-10-14",
    );
    expect(
      workspaceStartedAfter("2026-10-14", "2026-10-15T03:00:00Z", "America/New_York"),
    ).toBeNull();
    expect(workspaceStartedAfter("2026-10-20", "2026-10-15T03:00:00Z", "UTC")).toBeNull();
    expect(workspaceStartedAfter("2026-10-01", null, "UTC")).toBeNull();
  });
});
