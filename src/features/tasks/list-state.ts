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
  overdue: urlField.enum(["", "true"], ""),
  group: urlField.enum(["", "status"], ""),
  sort: urlField.enum(TASK_SORT_OPTIONS, "due_date"),
  order: urlField.enum(["asc", "desc"], "asc"),
  page: urlField.int(1, 1, 1_000_000),
  limit: urlField.int(25, 1, 100),
});
export type TaskListState = UrlState<typeof taskListUrl>;

export const PAGE_SIZES = [10, 25, 50, 100] as const;

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
    overdue: state.overdue === "true" ? "true" : undefined,
  };
}

/** True when any search or filter narrows the list (drives "no results" versus "no tasks yet"). */
export function hasActiveFilters(state: TaskListState): boolean {
  return Boolean(state.q || state.status || state.priority || state.mine || state.overdue);
}

/** Priority sorts most urgent first by default; the others start ascending. */
export const defaultOrderFor = (sort: TaskListState["sort"]): "asc" | "desc" =>
  sort === "priority" ? "desc" : "asc";
