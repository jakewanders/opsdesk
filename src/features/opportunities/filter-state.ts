import { defineUrlState, urlField, type UrlState } from "@/lib/api-client/url-state";
import { STAGES } from "@/lib/domain/pipeline";
import { isoDate } from "@/lib/validation";
import { OPPORTUNITY_SORTS } from "./schema";

/**
 * Everything the opportunities page keeps in its URL, for BOTH views, in one schema: a change made in the board never drops
 * a list parameter and the other way round (the URL helpers rebuild the query from the schema). Names match the API's query
 * where they exist. Defaults are left out of the URL; `""` means "no filter".
 *
 * `view` is `""` until someone chooses: the page then picks the board on a wide screen and the list on a narrow one.
 */
export const opportunityPageUrl = defineUrlState({
  view: urlField.enum(["", "board", "list"], ""),
  q: urlField.string("", 100),
  assignedTo: urlField.string("", 36),
  /** Only this customer's deals (set by the link on the customer page). */
  customerId: urlField.string("", 36),
  stage: urlField.enum(["", ...STAGES], ""),
  closeFrom: urlField.string("", 10),
  closeTo: urlField.string("", 10),
  sort: urlField.enum(OPPORTUNITY_SORTS, "updated_at"),
  order: urlField.enum(["asc", "desc"], "desc"),
  page: urlField.int(1, 1, 1_000_000),
  limit: urlField.int(25, 1, 100),
});
export type OpportunityPageState = UrlState<typeof opportunityPageUrl>;

export const PAGE_SIZES = [10, 25, 50, 100] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A date typed into the URL counts only if it is a real `YYYY-MM-DD` day; anything else is ignored rather than sent to the API. */
const validDate = (value: string): string | undefined =>
  isoDate().safeParse(value).success ? value : undefined;

/** The API query for the list view: empty or invalid filters are left out. */
export function toListQuery(
  state: OpportunityPageState,
): Record<string, string | number | undefined> {
  return {
    page: state.page,
    limit: state.limit,
    sort: state.sort,
    order: state.order,
    q: state.q || undefined,
    stage: state.stage || undefined,
    assignedTo: state.assignedTo || undefined,
    customerId: UUID.test(state.customerId) ? state.customerId : undefined,
    closeFrom: validDate(state.closeFrom),
    closeTo: validDate(state.closeTo),
  };
}

/** True when any search or filter narrows the list (drives "no results" versus "create your first"). */
export function hasActiveFilters(state: OpportunityPageState): boolean {
  return Boolean(
    state.q ||
    state.stage ||
    state.assignedTo ||
    UUID.test(state.customerId) ||
    validDate(state.closeFrom) ||
    validDate(state.closeTo),
  );
}

/** The view to show: the person's choice, else the board on a wide screen and the list on a narrow one. */
export function effectiveView(
  state: OpportunityPageState,
  viewport: "desktop" | "mobile",
): "board" | "list" {
  if (state.view === "board" || state.view === "list") return state.view;
  return viewport === "desktop" ? "board" : "list";
}
