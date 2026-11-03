import { defineUrlState, urlField, type UrlState } from "@/lib/api-client/url-state";
import { QUOTE_SORTS, QUOTE_STATUSES } from "./schema";

/**
 * The quote list's state as it lives in the URL (shareable, survives a reload). Parameter names match the API's query, so the server
 * page and the browser read the same URL the same way. Defaults are left out of the URL. `status` and `customerId` are "" for "all";
 * the dates are `YYYY-MM-DD` or "".
 */
export const quoteListUrl = defineUrlState({
  q: urlField.string("", 100),
  status: urlField.enum(["", ...QUOTE_STATUSES], ""),
  customerId: urlField.string("", 36),
  issueFrom: urlField.string("", 10),
  issueTo: urlField.string("", 10),
  /** `false` (default) lists active quotes, `true` lists archived ones. */
  archived: urlField.enum(["false", "true"], "false"),
  sort: urlField.enum(QUOTE_SORTS, "updated_at"),
  order: urlField.enum(["asc", "desc"], "desc"),
  page: urlField.int(1, 1, 1_000_000),
  limit: urlField.int(25, 1, 100),
});
export type QuoteListState = UrlState<typeof quoteListUrl>;

export const PAGE_SIZES = [10, 25, 50, 100] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A real calendar day written YYYY-MM-DD (so 2026-13-45 and 2026-02-30 are refused). */
const isRealDay = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

/** The API query for a URL state: empty or malformed filters are left out (a hand-edited URL never makes the page fail). */
export function toApiQuery(state: QuoteListState): Record<string, string | number | undefined> {
  return {
    page: state.page,
    limit: state.limit,
    sort: state.sort,
    order: state.order,
    q: state.q || undefined,
    status: state.status || undefined,
    customerId: UUID.test(state.customerId) ? state.customerId : undefined,
    issueFrom: isRealDay(state.issueFrom) ? state.issueFrom : undefined,
    issueTo: isRealDay(state.issueTo) ? state.issueTo : undefined,
    archived: state.archived === "true" ? "true" : undefined,
  };
}

/** True when any search or filter narrows the list (drives "no results" versus "no quotes yet"). */
export function hasActiveFilters(state: QuoteListState): boolean {
  const q = toApiQuery(state);
  return Boolean(q.q || q.status || q.customerId || q.issueFrom || q.issueTo || q.archived);
}
