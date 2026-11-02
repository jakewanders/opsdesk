"use client";

import {
  AlertTriangle,
  CalendarClock,
  CircleDollarSign,
  Gauge,
  Plus,
  Target,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { TaskDrawer } from "@/features/tasks/components/task-drawer";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiQuery } from "@/lib/api-client/provider";
import { formatUsd } from "@/lib/money/format";
import type { DashboardDto } from "../service";
import { DashboardTasks, useDashboardTasks } from "./dashboard-tasks";
import { KpiCard } from "./kpi-card";
import { RecentActivity } from "./recent-activity";
import { StageChart } from "./stage-chart";

type Props = {
  /** The dashboard as the server read it for this request, so the numbers are in the first paint. Null when it could not. */
  initial?: DashboardDto | null;
  canWrite: boolean;
  currentUserId: string;
  timeZone: string;
};

const NUMBER = new Intl.NumberFormat("en-US");

function Skeleton() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading the dashboard</span>
      <div aria-hidden="true" className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
        <div className="h-40 animate-pulse rounded-lg bg-muted" />
      </div>
    </div>
  );
}

/**
 * The dashboard (PRD 9.2). Everything comes from `GET /api/v1/dashboard` under the query key `["dashboard"]`, which every
 * mutation that can change a number invalidates (customers, opportunities, stage moves and tasks do). The numbers are
 * current state, not trends: there are no percentages or sparklines because nothing stored could support them.
 */
export function DashboardView({ initial = null, canWrite, currentUserId, timeZone }: Props) {
  const query = useApiQuery<DashboardDto>(["dashboard"], "/dashboard", {
    initialData: initial ? { data: initial, meta: {} } : undefined,
    // the server just read it; do not read it again the moment the browser mounts (mutations still refetch it)
    staleTime: initial ? 30_000 : undefined,
  });
  useDashboardTasks(); // start the task lists now, in parallel with the numbers
  const [taskDrawer, setTaskDrawer] = useState(false);
  const data = query.data?.data;

  const isEmpty =
    data !== undefined &&
    data.activeCustomers === 0 &&
    Object.values(data.opportunitiesByStage).every((s) => s.count === 0) &&
    data.overdueTasks === 0 &&
    data.tasksDueNext7Days === 0 &&
    data.recentActivity.length === 0;

  const asOf = data
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
      }).format(new Date(data.generatedAt))
    : null;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          {data ? (
            <p className="text-sm text-muted-foreground">
              Where things stand now, as of{" "}
              <time dateTime={data.generatedAt} title={new Date(data.generatedAt).toISOString()}>
                {asOf}
              </time>
              .
            </p>
          ) : null}
        </div>
        {canWrite ? (
          <nav aria-label="Quick actions" className="flex flex-wrap gap-2">
            <Link href="/app/customers/new" className={buttonVariants({ variant: "outline" })}>
              <Plus aria-hidden="true" />
              Add customer
            </Link>
            <Link href="/app/opportunities/new" className={buttonVariants({ variant: "outline" })}>
              <Plus aria-hidden="true" />
              Add opportunity
            </Link>
            <Button type="button" variant="outline" onClick={() => setTaskDrawer(true)}>
              <Plus aria-hidden="true" />
              Add task
            </Button>
          </nav>
        ) : null}
      </header>

      {query.isError ? (
        <ErrorAlert
          title="The dashboard could not be loaded"
          message={
            isClientApiError(query.error) ? query.error.message : "Something went wrong. Try again."
          }
          requestId={isClientApiError(query.error) ? query.error.requestId : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : query.isPending ? (
        <Skeleton />
      ) : data && isEmpty ? (
        <EmptyState
          icon={<Users />}
          title="Add your first customer"
          description="Your numbers, tasks and activity appear here as soon as you add records. Start with a customer, then track their deals and tasks."
          action={
            canWrite ? (
              <Link href="/app/customers/new" className={buttonVariants()}>
                <Plus aria-hidden="true" />
                Add customer
              </Link>
            ) : undefined
          }
        />
      ) : data ? (
        <>
          <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <KpiCard
              label="Active customers"
              value={NUMBER.format(data.activeCustomers)}
              href="/app/customers"
              icon={Users}
              action="View customers"
            />
            <KpiCard
              label="Open opportunities"
              value={NUMBER.format(data.openOpportunities)}
              href="/app/opportunities"
              icon={Target}
              action="View the pipeline"
            />
            <KpiCard
              label="Pipeline"
              value={formatUsd(data.pipelineCents, { whole: true })}
              exact={formatUsd(data.pipelineCents)}
              href="/app/opportunities?view=list"
              icon={CircleDollarSign}
              action="View opportunities"
            />
            <KpiCard
              label="Weighted pipeline"
              value={formatUsd(data.weightedPipelineCents, { whole: true })}
              exact={formatUsd(data.weightedPipelineCents)}
              href="/app/opportunities"
              icon={Gauge}
              action="View the pipeline"
            />
            <KpiCard
              label="Overdue tasks"
              value={NUMBER.format(data.overdueTasks)}
              href="/app/tasks?overdue=true"
              icon={AlertTriangle}
              attention={data.overdueTasks > 0}
              action="View overdue tasks"
            />
            <KpiCard
              label="Due in the next 7 days"
              value={NUMBER.format(data.tasksDueNext7Days)}
              href="/app/tasks?soon=true"
              icon={CalendarClock}
              action="View tasks due this week"
            />
          </section>
          <DashboardTasks today={data.today} timeZone={data.timeZone} canWrite={canWrite} />
          <div className="grid gap-6 lg:grid-cols-2">
            <StageChart byStage={data.opportunitiesByStage} />
            <RecentActivity
              events={data.recentActivity}
              currentUserId={currentUserId}
              timeZone={data.timeZone}
            />
          </div>
        </>
      ) : null}

      {canWrite ? (
        <TaskDrawer
          state={taskDrawer ? { mode: "create" } : null}
          onClose={() => setTaskDrawer(false)}
          currentUserId={currentUserId}
        />
      ) : null}
    </div>
  );
}
