import { describe, expect, it } from "vitest";
import { parseUrlState } from "@/lib/api-client/url-state";
import { effectiveView, hasActiveFilters, opportunityPageUrl, toListQuery } from "./filter-state";

const base = parseUrlState(opportunityPageUrl, new URLSearchParams());

describe("opportunity page URL state [SIT-228]", () => {
  it("defaults: no view chosen, newest first, 25 per page, nothing filtered", () => {
    expect(base).toMatchObject({ view: "", sort: "updated_at", order: "desc", page: 1, limit: 25 });
    expect(hasActiveFilters(base)).toBe(false);
  });
  it("an unknown view falls back to no choice", () => {
    expect(parseUrlState(opportunityPageUrl, new URLSearchParams("view=kanban")).view).toBe("");
  });
  it("toListQuery leaves out empty filters and invalid dates", () => {
    const q = toListQuery({ ...base, closeFrom: "2026-13-45", closeTo: "2026-12-31", q: "boiler" });
    expect(q).toMatchObject({ q: "boiler", closeTo: "2026-12-31" });
    expect(q.closeFrom).toBeUndefined();
    expect(q.stage).toBeUndefined();
    expect(q.assignedTo).toBeUndefined();
  });
  it("an invalid date alone does not count as an active filter", () => {
    expect(hasActiveFilters({ ...base, closeFrom: "nonsense" })).toBe(false);
    expect(hasActiveFilters({ ...base, stage: "won" })).toBe(true);
  });
  it("effectiveView: an explicit choice wins, otherwise board on desktop and list on mobile", () => {
    expect(effectiveView({ ...base, view: "list" }, "desktop")).toBe("list");
    expect(effectiveView({ ...base, view: "board" }, "mobile")).toBe("board");
    expect(effectiveView(base, "desktop")).toBe("board");
    expect(effectiveView(base, "mobile")).toBe("list");
  });
});
