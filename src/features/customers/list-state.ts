import { defineUrlState, urlField, type UrlState } from "@/lib/api-client/url-state";
import { CUSTOMER_SORTS, CUSTOMER_SOURCES, CUSTOMER_STATUSES } from "./schema";

/**
 * The customer list's state as it lives in the URL (shareable, survives a reload). Parameter names match the API's
 * query, so the server page and the browser read the same URL the same way. Defaults are left out of the URL.
 * `status` and `source` are "" for "all".
 */
export const customerListUrl = defineUrlState({
  q: urlField.string("", 100),
  status: urlField.enum(["", ...CUSTOMER_STATUSES], ""),
  source: urlField.enum(["", ...CUSTOMER_SOURCES], ""),
  /** `false` (default) lists active customers, `true` lists archived ones. */
  archived: urlField.enum(["false", "true"], "false"),
  sort: urlField.enum(CUSTOMER_SORTS, "updated_at"),
  order: urlField.enum(["asc", "desc"], "desc"),
  page: urlField.int(1, 1, 1_000_000),
  limit: urlField.int(25, 1, 100),
});
export type CustomerListState = UrlState<typeof customerListUrl>;

export const PAGE_SIZES = [10, 25, 50, 100] as const;

/** The API query for a URL state: empty filters are left out. */
export function toApiQuery(state: CustomerListState): Record<string, string | number | undefined> {
  return {
    page: state.page,
    limit: state.limit,
    sort: state.sort,
    order: state.order,
    q: state.q || undefined,
    status: state.status || undefined,
    source: state.source || undefined,
    archived: state.archived === "true" ? "true" : undefined,
  };
}

/** True when any search or filter narrows the list (drives "no results" versus "no customers yet"). */
export function hasActiveFilters(state: CustomerListState): boolean {
  return Boolean(state.q || state.status || state.source || state.archived === "true");
}
