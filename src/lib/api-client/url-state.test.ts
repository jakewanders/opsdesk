import { describe, expect, it } from "vitest";
import {
  applyUrlChange,
  defaultsOf,
  defineUrlState,
  parseUrlState,
  serializeUrlState,
  urlField,
} from "./url-state";

const schema = defineUrlState({
  q: urlField.string("", 20),
  page: urlField.int(1, 1, 500),
  sort: urlField.enum(["name", "-created", "stage"], "name"),
  stage: urlField.list(["lead", "qualified", "won", "lost"]),
});
const params = (qs: string) => new URLSearchParams(qs);

describe("URL state", () => {
  it("a clean list has a clean URL: defaults are omitted", () => {
    expect(serializeUrlState(schema, defaultsOf(schema))).toBe("");
    expect(serializeUrlState(schema, { page: 1, sort: "name", q: "", stage: [] })).toBe("");
  });
  it("reloading a URL restores the same search, filters, sort and page (round trip)", () => {
    const state = { q: "acme", page: 3, sort: "-created", stage: ["lead", "won"] };
    const qs = serializeUrlState(schema, state);
    expect(qs).toBe("q=acme&page=3&sort=-created&stage=lead%2Cwon");
    expect(parseUrlState(schema, params(qs))).toEqual(state);
  });
  it("equal states give the same URL whatever order the values came in", () => {
    expect(serializeUrlState(schema, { stage: ["won", "lead"] })).toBe(
      serializeUrlState(schema, { stage: ["lead", "won"] }),
    );
  });
  it("invalid or hostile values fall back to the default instead of failing", () => {
    const state = parseUrlState(
      schema,
      params("page=abc&sort=DROP TABLE&stage=lead,nope,%00&q=" + "x".repeat(200)),
    );
    expect(state).toEqual({ q: "x".repeat(20), page: 1, sort: "name", stage: ["lead"] });
    expect(parseUrlState(schema, params("page=0")).page).toBe(1);
    expect(parseUrlState(schema, params("page=999999")).page).toBe(1);
    expect(parseUrlState(schema, params("page=-4")).page).toBe(1);
    expect(parseUrlState(schema, params("page=2.5")).page).toBe(1);
    expect(parseUrlState(schema, params("q=%20%20hi%20")).q).toBe("hi");
  });
  it("unknown parameters are ignored and never written back", () => {
    expect(serializeUrlState(schema, parseUrlState(schema, params("utm=1&q=a")))).toBe("q=a");
  });
  it("a change to search, filter or sort goes back to page 1; a page change keeps the rest", () => {
    const current = { q: "a", page: 4, sort: "name", stage: [] as string[] };
    expect(applyUrlChange(schema, current, { q: "ab" }).page).toBe(1);
    expect(applyUrlChange(schema, current, { stage: ["won"] }).page).toBe(1);
    expect(applyUrlChange(schema, current, { sort: "stage" }).page).toBe(1);
    const paged = applyUrlChange(schema, current, { page: 5 });
    expect(paged).toEqual({ ...current, page: 5 });
    expect(applyUrlChange(schema, current, { q: "ab", page: 2 }).page).toBe(2);
  });
  it("refuses parameter names that look sensitive", () => {
    for (const name of [
      "token",
      "access_token",
      "password",
      "apiKey",
      "key",
      "email",
      "phone",
      "session",
      "secret",
      "authorization",
    ]) {
      expect(() => defineUrlState({ [name]: urlField.string() }), name).toThrow(/sensitive/);
    }
    expect(() =>
      defineUrlState({ author: urlField.string(), owner: urlField.string(), q: urlField.string() }),
    ).not.toThrow();
  });
});
