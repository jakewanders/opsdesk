"use client";

import { AlertTriangle, Check, ListTodo } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Button } from "@/components/ui/button";
import { TaskPriority } from "@/features/tasks/components/task-labels";
import type { TaskDto } from "@/features/tasks/schema";
import { useCompleteTask } from "@/features/tasks/use-complete-task";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiQuery } from "@/lib/api-client/provider";
import { relativeDay } from "../relative-day";
import { Skeleton as Shimmer } from "@/components/ui/skeleton";

const FULL = new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: "UTC" });
const SHORT = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const LIMIT = 5;

type Props = { today: string; timeZone: string; canWrite: boolean };

function Section({
  title,
  tasks,
  today,
  canWrite,
  onComplete,
  pending,
  seeAll,
}: {
  title: string;
  tasks: TaskDto[];
  today: string;
  canWrite: boolean;
  onComplete: (task: TaskDto) => void;
  pending: boolean;
  seeAll: string;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Link href={seeAll} className="touch-link text-sm underline-offset-4 hover:underline">
          See all
          <span className="sr-only"> {title.toLowerCase()}</span>
        </Link>
      </div>
      {tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing here.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              {canWrite ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  disabled={pending}
                  onClick={() => onComplete(task)}
                  aria-label={`Mark ${task.title} complete`}
                >
                  <Check aria-hidden="true" />
                </Button>
              ) : null}
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{task.title}</span>
                {task.dueDate ? (
                  <span className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                    {task.dueState === "overdue" ? (
                      <span className="inline-flex items-center gap-1 font-semibold text-destructive">
                        <AlertTriangle aria-hidden="true" className="size-3.5" />
                        Overdue
                      </span>
                    ) : null}
                    <span>{relativeDay(task.dueDate, today)}</span>
                    <time
                      dateTime={task.dueDate}
                      title={FULL.format(new Date(`${task.dueDate}T00:00:00Z`))}
                    >
                      {SHORT.format(new Date(`${task.dueDate}T00:00:00Z`))}
                    </time>
                  </span>
                ) : null}
              </div>
              <TaskPriority priority={task.priority} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Overdue tasks and tasks due in the next 7 days (the organization's days, from the API's own filters), each with quick
 * complete. Both lists live under the `["tasks", ...]` query prefix, so completing a task here, or anywhere, updates them
 * and refetches the dashboard's numbers.
 */
const overdueQuery = { overdue: "true", sort: "due_date", order: "asc", limit: LIMIT };
const soonQuery = { dueSoon: "true", sort: "due_date", order: "asc", limit: LIMIT };

/**
 * The two task lists. The dashboard calls this at the top of the page too, so they load at the same time as the numbers
 * instead of after them (one query each, shared by key).
 */
export function useDashboardTasks() {
  const overdue = useApiQuery<TaskDto[]>(["tasks", overdueQuery], "/tasks", {
    query: overdueQuery,
  });
  const soon = useApiQuery<TaskDto[]>(["tasks", soonQuery], "/tasks", { query: soonQuery });
  return { overdue, soon };
}

export function DashboardTasks({ today, timeZone, canWrite }: Props) {
  const complete = useCompleteTask(timeZone);
  const { overdue, soon } = useDashboardTasks();
  const failed = overdue.isError ? overdue : soon.isError ? soon : null;

  return (
    <section aria-labelledby="dash-tasks" className="flex flex-col gap-4">
      <h2 id="dash-tasks" className="text-lg font-semibold">
        Tasks that need you
      </h2>
      {failed ? (
        <ErrorAlert
          title="Tasks could not be loaded"
          message={
            isClientApiError(failed.error)
              ? failed.error.message
              : "Something went wrong. Try again."
          }
          requestId={isClientApiError(failed.error) ? failed.error.requestId : undefined}
          onRetry={() => void failed.refetch()}
        />
      ) : overdue.isPending || soon.isPending ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading tasks</span>
          <Shimmer aria-hidden="true" className="h-32 rounded-lg" />
        </div>
      ) : (overdue.data?.data.length ?? 0) === 0 && (soon.data?.data.length ?? 0) === 0 ? (
        <EmptyState
          icon={<ListTodo />}
          headingLevel={3}
          title="Nothing overdue or due this week"
          description="Tasks that are overdue or due in the next 7 days show up here."
        />
      ) : (
        <>
          <Section
            title="Overdue"
            tasks={overdue.data?.data ?? []}
            today={today}
            canWrite={canWrite}
            pending={complete.isPending}
            onComplete={(task) => complete.mutate({ task, completed: true })}
            seeAll="/app/tasks?overdue=true"
          />
          <Section
            title="Due in the next 7 days"
            tasks={soon.data?.data ?? []}
            today={today}
            canWrite={canWrite}
            pending={complete.isPending}
            onComplete={(task) => complete.mutate({ task, completed: true })}
            seeAll="/app/tasks?soon=true"
          />
        </>
      )}
    </section>
  );
}
