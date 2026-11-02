"use client";

import { Plus, Target } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Check, ListChecks, RotateCcw } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorAlert } from "@/components/shared/error-alert";
import { TableSkeleton } from "@/components/shared/skeletons";
import { Button, buttonVariants } from "@/components/ui/button";
import { StageLabel } from "@/features/opportunities/components/stage-badge";
import type { OpportunityDto } from "@/features/opportunities/schema";
import { DueDate, TaskPriority, TaskStatus } from "@/features/tasks/components/task-labels";
import { TaskDrawer, type DrawerState } from "@/features/tasks/components/task-drawer";
import type { TaskDto } from "@/features/tasks/schema";
import { useCompleteTask } from "@/features/tasks/use-complete-task";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiQuery } from "@/lib/api-client/provider";
import { formatUsd } from "@/lib/money/format";

const PAGE_SIZE = 10;
const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

type Customer = { id: string; displayName: string };

function Pager({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (page: number) => void;
}) {
  if (total <= PAGE_SIZE) return null;
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3 text-sm">
      <p aria-live="polite">
        Page {page} of {totalPages} ({total} in total)
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous page
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          Next page
        </Button>
      </div>
    </nav>
  );
}

/** This customer's opportunities (server-paged, newest change first). Archived customers still show their history. */
export function RelatedOpportunities({
  customer,
  canWrite,
  archived,
}: {
  customer: Customer;
  canWrite: boolean;
  archived: boolean;
}) {
  const [page, setPage] = useState(1);
  const query = useApiQuery<OpportunityDto[]>(
    ["opportunities-list", "customer", { customerId: customer.id, page }],
    "/opportunities",
    {
      query: { customerId: customer.id, page, limit: PAGE_SIZE, sort: "updated_at", order: "desc" },
      keepPrevious: true,
    },
  );
  const items = query.data?.data ?? [];
  const total = Number(query.data?.meta.total ?? 0);
  const add = canWrite && !archived;
  const addLink = (
    <Link href={`/app/opportunities/new?customerId=${customer.id}`} className={buttonVariants()}>
      <Plus aria-hidden="true" />
      Add opportunity
    </Link>
  );

  return (
    <div className="flex flex-col gap-3">
      {add && items.length > 0 ? <div className="flex justify-end">{addLink}</div> : null}
      {query.isError ? (
        <ErrorAlert
          title="Opportunities could not be loaded"
          message={
            isClientApiError(query.error) ? query.error.message : "Something went wrong. Try again."
          }
          requestId={isClientApiError(query.error) ? query.error.requestId : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : query.isPending ? (
        <TableSkeleton label="Loading opportunities" columns={4} rows={3} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Target />}
          title="No opportunities for this customer"
          description={
            add
              ? "Add a deal to track what this customer might buy."
              : "There are no opportunities on record for this customer."
          }
          action={add ? addLink : undefined}
        />
      ) : (
        <>
          <div
            role="region"
            aria-label="Opportunities table"
            // a scrollable region must be focusable so the table scrolls sideways with the keyboard
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            className="overflow-x-auto rounded-lg border border-border outline-none focus-visible:ring-3 focus-visible:ring-ring"
          >
            <table className="w-full min-w-[32rem] text-left text-sm">
              <caption className="sr-only">Opportunities for {customer.displayName}</caption>
              <thead className="border-b border-border bg-muted/50">
                <tr>
                  {["Title", "Stage", "Amount", "Expected close"].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">
                      <Link
                        href={`/app/opportunities/${o.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {o.title}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <StageLabel stage={o.stage} />
                    </td>
                    <td className="px-3 py-2 tabular-nums">{formatUsd(o.amountCents)}</td>
                    <td className="px-3 py-2">
                      {o.expectedCloseDate ? (
                        <time dateTime={o.expectedCloseDate}>
                          {day.format(new Date(`${o.expectedCloseDate}T00:00:00Z`))}
                        </time>
                      ) : (
                        <span className="text-muted-foreground">Not set</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            page={page}
            totalPages={Number(query.data?.meta.totalPages ?? 1)}
            total={total}
            onPage={setPage}
          />
        </>
      )}
    </div>
  );
}

/** This customer's tasks (every status, open first by due date), with quick complete and an "Add task" that starts on this customer. */
export function RelatedTasks({
  customer,
  canWrite,
  archived,
  currentUserId,
  timeZone,
}: {
  customer: Customer;
  canWrite: boolean;
  archived: boolean;
  currentUserId: string;
  timeZone: string;
}) {
  const [page, setPage] = useState(1);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const complete = useCompleteTask(timeZone);
  const apiQuery = {
    customerId: customer.id,
    page,
    limit: PAGE_SIZE,
    sort: "due_date",
    order: "asc",
  };
  const query = useApiQuery<TaskDto[]>(["tasks", apiQuery], "/tasks", {
    query: apiQuery,
    keepPrevious: true,
  });
  const items = query.data?.data ?? [];
  const total = Number(query.data?.meta.total ?? 0);
  const add = canWrite && !archived;
  const addButton = (
    <Button
      type="button"
      onClick={() =>
        setDrawer({ mode: "create", customer: { id: customer.id, name: customer.displayName } })
      }
    >
      <Plus aria-hidden="true" />
      Add task
    </Button>
  );

  return (
    <div className="flex flex-col gap-3">
      {add && items.length > 0 ? <div className="flex justify-end">{addButton}</div> : null}
      {query.isError ? (
        <ErrorAlert
          title="Tasks could not be loaded"
          message={
            isClientApiError(query.error) ? query.error.message : "Something went wrong. Try again."
          }
          requestId={isClientApiError(query.error) ? query.error.requestId : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : query.isPending ? (
        <TableSkeleton label="Loading tasks" columns={4} rows={3} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ListChecks />}
          title="No tasks for this customer"
          description={
            add
              ? "Add a task to remember what to do next."
              : "There are no tasks on record for this customer."
          }
          action={add ? addButton : undefined}
        />
      ) : (
        <>
          <div
            role="region"
            aria-label="Tasks table"
            // a scrollable region must be focusable so the table scrolls sideways with the keyboard
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            className="overflow-x-auto rounded-lg border border-border outline-none focus-visible:ring-3 focus-visible:ring-ring"
          >
            <table className="w-full min-w-[34rem] text-left text-sm">
              <caption className="sr-only">Tasks for {customer.displayName}</caption>
              <thead className="border-b border-border bg-muted/50">
                <tr>
                  {canWrite ? (
                    <th scope="col" className="w-10 px-3 py-2">
                      <span className="sr-only">Complete</span>
                    </th>
                  ) : null}
                  {["Task", "Status", "Due", "Priority"].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((task) => (
                  <tr key={task.id} className="border-b border-border last:border-0">
                    {canWrite ? (
                      <td className="px-3 py-2">
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
                    <td className="px-3 py-2">
                      {canWrite ? (
                        <button
                          type="button"
                          onClick={() => setDrawer({ mode: "edit", task })}
                          className="font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring"
                        >
                          {task.title}
                        </button>
                      ) : (
                        <span className="font-medium">{task.title}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <TaskStatus status={task.status} />
                    </td>
                    <td className="px-3 py-2">
                      <DueDate task={task} />
                    </td>
                    <td className="px-3 py-2">
                      <TaskPriority priority={task.priority} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            page={page}
            totalPages={Number(query.data?.meta.totalPages ?? 1)}
            total={total}
            onPage={setPage}
          />
        </>
      )}
      {canWrite ? (
        <TaskDrawer state={drawer} onClose={() => setDrawer(null)} currentUserId={currentUserId} />
      ) : null}
    </div>
  );
}
