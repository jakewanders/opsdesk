import { describe, expect, it } from "vitest";
import { parseUrlState } from "@/lib/api-client/url-state";
import { activityPageUrl, hasActiveFilters, toActivityQuery } from "./filter-state";

const parse = (qs: string) => parseUrlState(activityPageUrl, new URLSearchParams(qs));
const ID = "11111111-1111-4111-8111-111111111111";

describe("activity page URL state [SIT-257]", () => {
  it("defaults to page 1 of 25 with no filters", () => {
    const s = parse("");
    expect(s).toMatchObject({ page: 1, limit: 25, entityType: "", action: "", actor: "" });
    expect(hasActiveFilters(s)).toBe(false);
  });
  it("valid parameters become the API query", () => {
    const q = toActivityQuery(
      parse(
        `entityType=task&action=completed&actor=${ID}&from=2026-10-01&to=2026-10-31&page=3&limit=50`,
      ),
    );
    expect(q).toEqual({
      page: 3,
      limit: 50,
      entityType: "task",
      action: "completed",
      actor: ID,
      from: "2026-10-01",
      to: "2026-10-31",
    });
  });
  it("system is a valid actor; anything else that is not an id is dropped", () => {
    expect(toActivityQuery(parse("actor=system")).actor).toBe("system");
    expect(toActivityQuery(parse("actor=bob")).actor).toBeUndefined();
  });
  it("unknown kinds and actions fall back to no filter; bad dates never reach the API", () => {
    const q = toActivityQuery(parse("entityType=nope&action=nope&from=2026-13-40&to=junk"));
    expect(q).toMatchObject({
      entityType: undefined,
      action: undefined,
      from: undefined,
      to: undefined,
    });
    expect(hasActiveFilters(parse("from=2026-13-40"))).toBe(false);
  });
  it("a reversed range keeps working by dropping `to` instead of failing the page with a 422", () => {
    const q = toActivityQuery(parse("from=2026-10-31&to=2026-10-01"));
    expect(q.from).toBe("2026-10-31");
    expect(q.to).toBeUndefined();
  });
});
