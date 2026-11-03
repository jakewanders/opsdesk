import { describe, expect, it } from "vitest";
import { parseUrlState, serializeUrlState } from "@/lib/api-client/url-state";
import { hasActiveFilters, quoteListUrl, toApiQuery } from "./list-state";

const parse = (qs: string) => parseUrlState(quoteListUrl, new URLSearchParams(qs));

describe("quote list URL state", () => {
  it("defaults are left out of the URL", () => {
    expect(serializeUrlState(quoteListUrl, parse(""))).toBe("");
    expect(hasActiveFilters(parse(""))).toBe(false);
  });
  it("round-trips filters, dates, sort and page", () => {
    const qs =
      "q=roof&status=sent&issueFrom=2026-01-01&issueTo=2026-02-01&sort=total_cents&order=asc&page=3&limit=50";
    const state = parse(qs);
    expect(state).toMatchObject({
      q: "roof",
      status: "sent",
      issueFrom: "2026-01-01",
      sort: "total_cents",
      order: "asc",
      page: 3,
      limit: 50,
    });
    expect(new URLSearchParams(serializeUrlState(quoteListUrl, state))).toEqual(
      new URLSearchParams(qs),
    );
    expect(hasActiveFilters(state)).toBe(true);
  });
  it("invalid values fall back instead of failing", () => {
    const state = parse("status=nope&sort=drop&page=-4&limit=9999");
    expect(state).toMatchObject({ status: "", sort: "updated_at", page: 1 });
  });
  it("a malformed customer id or date never reaches the API query", () => {
    const q = toApiQuery(parse("customerId=not-a-uuid&issueFrom=yesterday&issueTo=2026-13-45x"));
    expect(q.customerId).toBeUndefined();
    expect(q.issueFrom).toBeUndefined();
    expect(q.issueTo).toBeUndefined();
    expect(hasActiveFilters(parse("customerId=not-a-uuid"))).toBe(false);
  });
  it("a good customer id and dates are passed through", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const q = toApiQuery(
      parse(`customerId=${id}&issueFrom=2026-01-01&issueTo=2026-01-31&archived=true`),
    );
    expect(q).toMatchObject({
      customerId: id,
      issueFrom: "2026-01-01",
      issueTo: "2026-01-31",
      archived: "true",
    });
  });
});
