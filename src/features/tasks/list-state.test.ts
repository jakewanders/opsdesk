import { describe, expect, it } from "vitest";
import { applyUrlChange, parseUrlState, serializeUrlState } from "@/lib/api-client/url-state";
import { defaultOrderFor, hasActiveFilters, taskListUrl, toApiQuery } from "./list-state";

const parse = (qs: string) => parseUrlState(taskListUrl, new URLSearchParams(qs));

describe("task list URL state [SIT-237]", () => {
  it("an empty URL is the defaults (due date, soonest first) and defaults are not written back", () => {
    const s = parse("");
    expect(s).toMatchObject({
      q: "",
      status: "",
      priority: "",
      mine: "",
      overdue: "",
      group: "",
      sort: "due_date",
      order: "asc",
      page: 1,
      limit: 25,
    });
    expect(serializeUrlState(taskListUrl, s)).toBe("");
  });
  it("invalid values fall back to defaults instead of failing", () => {
    const s = parse(
      "status=open&priority=critical&mine=yes&overdue=1&group=owner&sort=title&order=up&page=-2&limit=9999",
    );
    expect(s).toMatchObject({
      status: "",
      priority: "",
      mine: "",
      overdue: "",
      group: "",
      sort: "due_date",
      order: "asc",
      page: 1,
    });
    expect(s.limit).toBeLessThanOrEqual(100);
  });
  it("round-trips every filter, the sort, the grouping and the page", () => {
    const s = parse(
      "q=call&status=blocked&priority=urgent&mine=true&overdue=true&group=status&sort=priority&order=desc&page=3&limit=50",
    );
    expect(parse(serializeUrlState(taskListUrl, s))).toEqual(s);
  });
  it("changing a filter returns to page 1; changing only the page does not", () => {
    const s = parse("page=4");
    expect(applyUrlChange(taskListUrl, s, { overdue: "true" }).page).toBe(1);
    expect(applyUrlChange(taskListUrl, s, { page: 5 }).page).toBe(5);
  });
  it("toApiQuery maps the checkboxes to the API's names and leaves empty filters out", () => {
    const q = toApiQuery(parse("mine=true&overdue=true&status=todo"));
    expect(q).toMatchObject({
      assignedToMe: "true",
      overdue: "true",
      status: "todo",
      sort: "due_date",
      order: "asc",
      page: 1,
      limit: 25,
    });
    expect(q.q).toBeUndefined();
    expect(q.priority).toBeUndefined();
    expect(toApiQuery(parse("")).assignedToMe).toBeUndefined();
    expect(toApiQuery(parse("")).overdue).toBeUndefined();
  });
  it("hasActiveFilters is true for any narrowing filter and false for sort, grouping and paging", () => {
    expect(hasActiveFilters(parse("sort=priority&group=status&page=2"))).toBe(false);
    for (const qs of [
      "q=x",
      "status=done",
      "priority=low",
      "mine=true",
      "overdue=true",
      "soon=true",
    ])
      expect(hasActiveFilters(parse(qs)), qs).toBe(true);
  });
  it("priority sorts most urgent first by default; the others start ascending", () => {
    expect(defaultOrderFor("priority")).toBe("desc");
    expect(defaultOrderFor("due_date")).toBe("asc");
    expect(defaultOrderFor("created_at")).toBe("asc");
  });
  it("[SIT-255] soon=true becomes the dueSoon API filter, and anything else is ignored", () => {
    expect(toApiQuery(parse("soon=true")).dueSoon).toBe("true");
    expect(toApiQuery(parse("soon=yes")).dueSoon).toBeUndefined();
    expect(toApiQuery(parse("")).dueSoon).toBeUndefined();
  });
});
