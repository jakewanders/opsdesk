import { defineUrlState, urlField, type UrlState } from "@/lib/api-client/url-state";
import { TASK_PRIORITIES, TASK_STATUSES } from "./schema";

/** The sorts the page offers (a subset of what the API allows). */
export const TASK_SORT_OPTIONS = ["due_date", "priority", "created_at"] as const;

/**
 * The task list's state as it lives in the URL (shareable, survives a reload). Parameter names match the API's query where
 * they exist. Defaults are left out of the URL; `""` means "no filter".
 */
export const taskListUrl = defineUrlState({
  q: urlField.string("", 100),
  status: urlField.enum(["", ...TASK_STATUSES], ""),
  priority: urlField.enum(["", ...TASK_PRIORITIES], ""),
  mine: urlField.enum(["", "true"], ""),
  /** Only tasks linked to this customer or deal (set by the links on their pages). */
  customerId: urlField.string("", 36),
  opportunityId: urlField.string("", 36),
  overdue: urlField.enum(["", "true"], ""),
  soon: urlField.enum(["", "true"], ""),
  group: urlField.enum(["", "status"], ""),
  sort: urlField.enum(TASK_SORT_OPTIONS, "due_date"),
  order: urlField.enum(["asc", "desc"], "asc"),
  page: urlField.int(1, 1, 1_000_000),
  limit: urlField.int(25, 1, 100),
});
export type TaskListState = UrlState<typeof taskListUrl>;

export const PAGE_SIZES = [10, 25, 50, 100] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The API query for a URL state: empty filters are left out. */
export function toApiQuery(state: TaskListState): Record<string, string | number | undefined> {
  return {
    page: state.page,
    limit: state.limit,
    sort: state.sort,
    order: state.order,
    q: state.q || undefined,
    status: state.status || undefined,
    priority: state.priority || undefined,
    assignedToMe: state.mine === "true" ? "true" : undefined,
    customerId: UUID.test(state.customerId) ? state.customerId : undefined,
    opportunityId: UUID.test(state.opportunityId) ? state.opportunityId : undefined,
    overdue: state.overdue === "true" ? "true" : undefined,
    dueSoon: state.soon === "true" ? "true" : undefined,
  };
}

/** True when any search or filter narrows the list (drives "no results" versus "no tasks yet"). */
export function hasActiveFilters(state: TaskListState): boolean {
  return Boolean(
    state.q ||
    state.status ||
    state.priority ||
    state.mine ||
    state.overdue ||
    state.soon ||
    UUID.test(state.customerId) ||
    UUID.test(state.opportunityId),
  );
}

/** Priority sorts most urgent first by default; the others start ascending. */
export const defaultOrderFor = (sort: TaskListState["sort"]): "asc" | "desc" =>
  sort === "priority" ? "desc" : "asc";
