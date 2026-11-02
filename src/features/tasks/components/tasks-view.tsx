"use client";

import { Check, ListTodo, Plus, RotateCcw, Search } from "lucide-react";
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorAlert } from "@/components/shared/error-alert";
import { TableSkeleton } from "@/components/shared/skeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiQuery } from "@/lib/api-client/provider";
import { serializeUrlState } from "@/lib/api-client/url-state";
import { useDebouncedUrlParam, useUrlState } from "@/lib/api-client/use-url-state";
import type { ApiMeta } from "@/lib/api/types";
import type { MemberDto } from "@/features/members/service";
import { cn } from "@/lib/utils";
import {
  defaultOrderFor,
  hasActiveFilters,
  PAGE_SIZES,
  TASK_SORT_OPTIONS,
  taskListUrl,
  toApiQuery,
  type TaskListState,
} from "../list-state";
import { TASK_PRIORITIES, TASK_STATUSES, type TaskDto } from "../schema";
import { useCompleteTask } from "../use-complete-task";
import { TaskDrawer, type DrawerState } from "./task-drawer";
import { DueDate, PRIORITY_LABELS, STATUS_LABELS, TaskPriority, TaskStatus } from "./task-labels";

type Initial = { items: TaskDto[]; meta: ApiMeta } | null;
type Props = {
  /** The first page, read on the server with the caller's session. Null if that read failed (the browser retries). */
  initial: Initial;
  /** The URL state the server rendered; the first read is only reused while the URL still matches. */
  initialState: TaskListState;
  /** Owner, admin and member may complete tasks; viewers see read-only rows. */
  canWrite: boolean;
  currentUserId: string;
  /** The organization's time zone, for the "completed" times. */
  timeZone: string;
};

const SORT_LABELS = {
  due_date: "Due date",
  priority: "Priority",
  created_at: "Date created",
} as const;
const SELECT =
  "h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring";

/**
 * The task list (PRD 9.5): search, filters, sorting, optional grouping by status and paging all live in the URL; the first
 * page comes from the server, then TanStack Query keeps it current. Overdue and due-today come from the API (the shared
 * rule, in the organization's time zone), shown as words with icons.
 */
export function TasksView({ initial, initialState, canWrite, currentUserId, timeZone }: Props) {
  const [state, setState] = useUrlState(taskListUrl);
  const [search, onSearch] = useDebouncedUrlParam(state.q, (q) => setState({ q }));

  const apiQuery = toApiQuery(state);
  const sameAsServer =
    serializeUrlState(taskListUrl, state) === serializeUrlState(taskListUrl, initialState);
  const query = useApiQuery<TaskDto[]>(["tasks", apiQuery], "/tasks", {
    query: apiQuery,
    initialData: sameAsServer && initial ? { data: initial.items, meta: initial.meta } : undefined,
    // the server just read this page; don't read it again the moment the browser mounts
    staleTime: sameAsServer && initial ? 30_000 : undefined,
    keepPrevious: true,
  });
  const members = useApiQuery<MemberDto[]>(["members"], "/members");
  const ownerName = (id: string | null) =>
    id === null
      ? "Unassigned"
      : id === currentUserId
        ? "You"
        : (members.data?.data.find((m) => m.userId === id)?.displayName ?? "Teammate");

  const complete = useCompleteTask(timeZone);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);

  const items = useMemo(() => query.data?.data ?? [], [query.data]);
  const meta = query.data?.meta;
  const total = Number(meta?.total ?? 0);
  const totalPages = Number(meta?.totalPages ?? 0);
  const filtered = hasActiveFilters(state);
  const from = total === 0 ? 0 : (state.page - 1) * state.limit + 1;
  const to = Math.min(total, (state.page - 1) * state.limit + items.length);
  const pastTheEnd = items.length === 0 && total > 0;
  const clear = () =>
    setState({ q: "", status: "", priority: "", mine: "", overdue: "", soon: "" });

  const groups = useMemo(() => {
    if (state.group !== "status") return [{ key: "", label: "", rows: items }];
    return TASK_STATUSES.map((s) => ({
      key: s,
      label: STATUS_LABELS[s],
      rows: items.filter((t) => t.status === s),
    })).filter((g) => g.rows.length > 0);
  }, [items, state.group]);

  const completedAt = (task: TaskDto) =>
    task.completedAt
      ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone }).format(
          new Date(task.completedAt),
        )
      : null;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        {canWrite ? (
          <Button type="button" onClick={() => setDrawer({ mode: "create" })}>
            <Plus aria-hidden="true" />
            Add task
          </Button>
        ) : null}
      </header>

      <form
        role="search"
        aria-label="Filter tasks"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="flex min-w-56 flex-1 flex-col gap-1 text-sm font-medium">
          <label htmlFor="task-search">Search</label>
          <span className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="task-search"
              type="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Task title"
              className="pl-8"
              autoComplete="off"
              maxLength={100}
            />
          </span>
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium">
          <label htmlFor="task-status">Status</label>
          <select
            id="task-status"
            className={SELECT}
            value={state.status}
            onChange={(e) => setState({ status: e.target.value })}
          >
            <option value="">All statuses</option>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium">
          <label htmlFor="task-priority">Priority</label>
          <select
            id="task-priority"
            className={SELECT}
            value={state.priority}
            onChange={(e) => setState({ priority: e.target.value })}
          >
            <option value="">All priorities</option>
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium">
          <label htmlFor="task-sort">Sort by</label>
          <select
            id="task-sort"
            className={SELECT}
            value={state.sort}
            onChange={(e) => {
              const sort = e.target.value as TaskListState["sort"];
              setState({ sort, order: defaultOrderFor(sort) });
            }}
          >
            {TASK_SORT_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium">
          <label htmlFor="task-order">Order</label>
          <select
            id="task-order"
            className={SELECT}
            value={state.order}
            onChange={(e) => setState({ order: e.target.value })}
          >
            <option value="asc">
              {state.sort === "priority"
                ? "Lowest first"
                : state.sort === "created_at"
                  ? "Oldest first"
                  : "Soonest first"}
            </option>
            <option value="desc">
              {state.sort === "priority"
                ? "Most urgent first"
                : state.sort === "created_at"
                  ? "Newest first"
                  : "Latest first"}
            </option>
          </select>
        </div>
        <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-1.5 text-sm">
          <legend className="sr-only">Quick filters</legend>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.mine === "true"}
              onChange={(e) => setState({ mine: e.target.checked ? "true" : "" })}
            />
            Assigned to me
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.overdue === "true"}
              onChange={(e) => setState({ overdue: e.target.checked ? "true" : "" })}
            />
            Overdue
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.soon === "true"}
              onChange={(e) => setState({ soon: e.target.checked ? "true" : "" })}
            />
            Due in the next 7 days
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.group === "status"}
              onChange={(e) => setState({ group: e.target.checked ? "status" : "" })}
            />
            Group by status
          </label>
        </fieldset>
        {filtered ? (
          <Button type="button" variant="ghost" onClick={clear}>
            Clear filters
          </Button>
        ) : null}
      </form>

      {query.isError ? (
        <ErrorAlert
          title="Tasks could not be loaded"
          message={
            isClientApiError(query.error) ? query.error.message : "Something went wrong. Try again."
          }
          requestId={isClientApiError(query.error) ? query.error.requestId : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {query.isPending ? (
        <TableSkeleton label="Loading tasks" columns={6} rows={8} />
      ) : query.data && total === 0 && !filtered ? (
        <EmptyState
          icon={<ListTodo />}
          title="No tasks yet"
          description="Tasks you add for customers and deals appear here, with what is overdue and what is due today."
        />
      ) : query.data && (total === 0 || pastTheEnd) ? (
        <EmptyState
          icon={<Search />}
          title={pastTheEnd ? "There are no tasks on this page" : "No tasks match"}
          description={
            pastTheEnd
              ? "The list has fewer pages than that."
              : "Nothing matches the current search and filters. Try fewer words or clear the filters."
          }
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => (pastTheEnd ? setState({ page: 1 }) : clear())}
            >
              {pastTheEnd ? "Go to the first page" : "Clear filters"}
            </Button>
          }
        />
      ) : query.data ? (
        <>
          <div
            role="region"
            aria-label="Tasks table"
            // a scrollable region must be focusable so the table can scroll sideways with the keyboard
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            aria-busy={query.isFetching}
            className={cn(
              "overflow-x-auto rounded-lg border border-border outline-none focus-visible:ring-3 focus-visible:ring-ring",
              query.isPlaceholderData && "opacity-60",
            )}
          >
            <table className="w-full min-w-[60rem] text-left text-sm">
              <caption className="sr-only">
                Tasks, page {state.page} of {Math.max(totalPages, 1)}, {total} in total
              </caption>
              <thead className="border-b border-border bg-muted/50">
                <tr>
                  {canWrite ? (
                    <th scope="col" className="w-12 px-3 py-2">
                      <span className="sr-only">Complete</span>
                    </th>
                  ) : null}
                  <th scope="col" className="px-3 py-2 font-medium">
                    Task
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 font-medium"
                    aria-sort={
                      state.sort === "priority"
                        ? state.order === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    Priority
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 font-medium"
                    aria-sort={
                      state.sort === "due_date"
                        ? state.order === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    Due
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Owner
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Related to
                  </th>
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody key={group.key || "all"}>
                  {state.group === "status" ? (
                    <tr className="bg-muted/30">
                      <th
                        scope="rowgroup"
                        colSpan={canWrite ? 7 : 6}
                        className="px-3 py-1.5 text-left font-semibold"
                      >
                        {group.label} ({group.rows.length})
                      </th>
                    </tr>
                  ) : null}
                  {group.rows.map((task) => (
                    <Fragment key={task.id}>
                      <tr
                        className={cn(
                          "border-b border-border last:border-0 hover:bg-muted/40",
                          task.status === "done" && "text-muted-foreground",
                        )}
                      >
                        {canWrite ? (
                          <td className="px-3 py-2 align-middle">
                            <Button
                              type="button"
                              variant="outline"
                              size="icon-sm"
                              disabled={complete.isPending}
                              onClick={() =>
                                complete.mutate({ task, completed: task.status !== "done" })
                              }
                              aria-label={
                                task.status === "done"
                                  ? `Reopen ${task.title}`
                                  : `Mark ${task.title} complete`
                              }
                            >
                              {task.status === "done" ? (
                                <RotateCcw aria-hidden="true" />
                              ) : (
                                <Check aria-hidden="true" />
                              )}
                            </Button>
                          </td>
                        ) : null}
                        <td className="px-3 py-2 align-middle">
                          {canWrite ? (
                            <button
                              type="button"
                              onClick={() => setDrawer({ mode: "edit", task })}
                              className={cn(
                                "rounded-sm text-left font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring",
                                task.status === "done" && "line-through",
                              )}
                            >
                              {task.title}
                              <span className="sr-only"> (edit)</span>
                            </button>
                          ) : (
                            <span
                              className={cn(
                                "font-medium",
                                task.status === "done" && "line-through",
                              )}
                            >
                              {task.title}
                            </span>
                          )}
                          {task.archivedAt ? (
                            <span className="ml-2 text-xs">(archived)</span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <TaskPriority priority={task.priority} />
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <DueDate task={task} />
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <TaskStatus status={task.status} />
                          {completedAt(task) ? (
                            <span className="block text-xs text-muted-foreground">
                              Completed {completedAt(task)}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 align-middle">{ownerName(task.assignedTo)}</td>
                        <td className="px-3 py-2 align-middle">
                          {task.customerId ? (
                            <Link
                              href={`/app/customers/${task.customerId}`}
                              className="block py-1 underline-offset-4 hover:underline"
                            >
                              {task.customerName ?? "Customer"}
                            </Link>
                          ) : null}
                          {task.opportunityId ? (
                            <Link
                              href={`/app/opportunities/${task.opportunityId}`}
                              className="block py-1 underline-offset-4 hover:underline"
                            >
                              {task.opportunityTitle ?? "Opportunity"}
                            </Link>
                          ) : null}
                          {!task.customerId && !task.opportunityId ? (
                            <span className="text-muted-foreground">-</span>
                          ) : null}
                        </td>
                      </tr>
                    </Fragment>
                  ))}
                </tbody>
              ))}
            </table>
          </div>

          <nav
            aria-label="Pagination"
            className="flex flex-wrap items-center justify-between gap-3 text-sm"
          >
            <p aria-live="polite">
              Showing {from} to {to} of {total}
              {state.group === "status" ? " (grouped within this page)" : ""}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">
                Rows per page
                <select
                  className={SELECT}
                  value={state.limit}
                  onChange={(e) => setState({ limit: Number(e.target.value) })}
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={state.page <= 1}
                onClick={() => setState({ page: state.page - 1 })}
              >
                Previous page
              </Button>
              <span>
                Page {state.page} of {Math.max(totalPages, 1)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={state.page >= totalPages}
                onClick={() => setState({ page: state.page + 1 })}
              >
                Next page
              </Button>
            </div>
          </nav>
        </>
      ) : null}
      <TaskDrawer state={drawer} onClose={() => setDrawer(null)} currentUserId={currentUserId} />
    </div>
  );
}
