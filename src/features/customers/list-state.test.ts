import { describe, expect, it } from "vitest";
import { hasActiveFilters, customerListUrl, toApiQuery } from "./list-state";
import { applyUrlChange, parseUrlState, serializeUrlState } from "@/lib/api-client/url-state";

const parse = (qs: string) => parseUrlState(customerListUrl, new URLSearchParams(qs));

describe("customer list URL state [SIT-219]", () => {
  it("an empty URL is the defaults, and defaults are not written back", () => {
    const s = parse("");
    expect(s).toMatchObject({
      q: "",
      status: "",
      source: "",
      sort: "updated_at",
      order: "desc",
      page: 1,
      limit: 25,
    });
    expect(serializeUrlState(customerListUrl, s)).toBe("");
  });

  it("invalid values fall back to defaults instead of failing", () => {
    const s = parse("status=bogus&sort=password&order=sideways&page=-4&limit=9999");
    expect(s).toMatchObject({ status: "", sort: "updated_at", order: "desc", page: 1 });
    expect(s.limit).toBeLessThanOrEqual(100);
  });

  it("round-trips search, filters, sort and page", () => {
    const s = parse(
      "q=acme&status=lead&source=referral&sort=display_name&order=asc&page=3&limit=50",
    );
    expect(parse(serializeUrlState(customerListUrl, s))).toEqual(s);
  });

  it("changing a filter returns to page 1", () => {
    const s = parse("page=4");
    expect(applyUrlChange(customerListUrl, s, { status: "active" }).page).toBe(1);
  });

  it("toApiQuery leaves empty filters out", () => {
    const q = toApiQuery(parse("status=lead"));
    expect(q).toMatchObject({ status: "lead", page: 1, limit: 25 });
    expect(q.q).toBeUndefined();
    expect(q.source).toBeUndefined();
  });

  it("hasActiveFilters is true for search or any filter, false otherwise", () => {
    expect(hasActiveFilters(parse(""))).toBe(false);
    expect(hasActiveFilters(parse("page=2&sort=status"))).toBe(false);
    expect(hasActiveFilters(parse("q=x"))).toBe(true);
    expect(hasActiveFilters(parse("source=other"))).toBe(true);
  });
});
