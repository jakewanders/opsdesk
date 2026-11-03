"use client";

import { BarChart3, Plus } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { FictionalDataNote } from "@/components/demo/fictional-data-note";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorAlert } from "@/components/shared/error-alert";
import { buttonVariants } from "@/components/ui/button";
import { StageChart } from "@/features/dashboard/components/stage-chart";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiQuery } from "@/lib/api-client/provider";
import { useUrlState } from "@/lib/api-client/use-url-state";
import { useRememberList } from "@/lib/api-client/use-remember-list";
import { CopyLinkButton } from "@/components/shared/copy-link-button";
import {
  eventTotals,
  formatRange,
  reportUrl,
  SOURCE_LABELS,
  toApiQuery,
  trendRows,
  winRate,
  workspaceStartedAfter,
  type ReportUrlState,
} from "../report-data";
import type { ReportDto } from "../service";
import { ExportCsvButton } from "@/features/exports/export-csv-button";
import { BasisTag, ReportChart } from "./report-chart";
import { RangeControl } from "./range-control";

type Props = {
  /** The report as the server read it for this request's URL, so the charts are in the first paint. Null when it could not. */
  initial: ReportDto | null;
  /** The URL state `initial` was read for. */
  initialState: ReportUrlState;
  canWrite: boolean;
  isDemo: boolean;
  timeZone: string;
  /** When the workspace was created (ISO), to say that days before it hold no data. */
  workspaceCreatedAt: string | null;
};

function Skeleton() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading the reports</span>
      <div aria-hidden="true" className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-80 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    </div>
  );
}

const describe = (data: ReportDto, key: string) =>
  data.metrics.find((m) => m.key === key)?.description ?? "";

/**
 * /app/reports (PRD 9.7). Everything comes from `GET /api/v1/reports` for the range in the URL; nothing is computed or invented in
 * the browser except sums of the buckets the server sent (totals, the win rate). Each chart says what it is counted on.
 */
export function ReportsView({
  initial,
  initialState,
  canWrite,
  isDemo,
  timeZone,
  workspaceCreatedAt,
}: Props) {
  const [state, setState] = useUrlState(reportUrl);
  useRememberList("reports");
  const apiQuery = useMemo(() => toApiQuery(state), [state]);
  const seeded = JSON.stringify(toApiQuery(initialState)) === JSON.stringify(apiQuery);
  const query = useApiQuery<ReportDto>(["reports", apiQuery], "/reports", {
    query: apiQuery,
    keepPrevious: true,
    initialData: seeded && initial ? { data: initial, meta: {} } : undefined,
    staleTime: seeded && initial ? 30_000 : undefined,
  });
  const data = query.data?.data;
  const refreshing = query.isFetching && !query.isPending;

  const totals = data ? eventTotals(data.buckets) : null;
  const rate = data ? winRate(data.buckets) : null;
  const noEvents = totals
    ? totals.created + totals.won + totals.lost + totals.completed === 0
    : false;
  const noSources = data ? Object.values(data.customersBySource).every((n) => n === 0) : false;
  const noDeals = data
    ? Object.values(data.opportunitiesByStage).every((s) => s.count === 0)
    : false;
  const nothingAtAll = noEvents && noSources && noDeals;
  const rangeText = data ? formatRange(data.range.from, data.range.to, data.timeZone) : null;
  const startedAfter = data
    ? workspaceStartedAfter(data.range.from, workspaceCreatedAt, timeZone)
    : null;
  const rows = data ? trendRows(data.buckets) : [];
  const sourceRows = data
    ? Object.entries(data.customersBySource).map(([source, count]) => ({
        label: SOURCE_LABELS[source] ?? source,
        count,
      }))
    : [];

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
            {rangeText ? (
              <>
                <span className="font-medium text-foreground">{rangeText}</span>
                {` · ${data!.range.days} ${data!.range.days === 1 ? "day" : "days"}, by ${data!.range.bucket}`}
                {refreshing ? " · Updating…" : ""}
              </>
            ) : (
              "Choose a range to see how the business moved."
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyLinkButton />
          <ExportCsvButton entity="reports" query={apiQuery} noun="report" />
        </div>
      </header>

      {isDemo ? <FictionalDataNote /> : null}

      <RangeControl
        key={`${state.range}:${data?.range.from ?? ""}:${data?.range.to ?? ""}`}
        state={state}
        shown={data ? { from: data.range.from, to: data.range.to } : null}
        onChange={setState}
      />

      {startedAfter ? (
        <p role="note" className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
          This workspace was created on {startedAfter}, so the earlier days in this range have no
          data.
        </p>
      ) : null}

      {query.isError && !data ? (
        <ErrorAlert
          title="The reports could not be loaded"
          message={
            isClientApiError(query.error) ? query.error.message : "Something went wrong. Try again."
          }
          requestId={isClientApiError(query.error) ? query.error.requestId : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : query.isPending ? (
        <Skeleton />
      ) : data && nothingAtAll ? (
        <EmptyState
          icon={<BarChart3 />}
          title="Nothing to report yet"
          description={`No customers, deals or tasks were added or finished between ${rangeText}, and there are no deals in the pipeline. Pick a longer range, or add some records and they appear here.`}
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
          {query.isError ? (
            <ErrorAlert
              title="Showing the last reports that loaded"
              message={isClientApiError(query.error) ? query.error.message : "The refresh failed."}
              requestId={isClientApiError(query.error) ? query.error.requestId : undefined}
              onRetry={() => void query.refetch()}
            />
          ) : null}
          <div className={`grid gap-4 lg:grid-cols-2 ${refreshing ? "opacity-70" : ""}`}>
            <ReportChart
              id="rep-trend"
              title="Opportunities created, won and lost"
              basis="event"
              description={`${describe(data, "opportunitiesCreated")} ${describe(data, "opportunitiesWon")} ${describe(data, "opportunitiesLost")}`}
              rows={rows}
              series={[
                { key: "created", label: "Created", color: "var(--chart-1)" },
                { key: "won", label: "Won", color: "var(--chart-2)", dash: "6 3" },
                { key: "lost", label: "Lost", color: "var(--chart-5)", dash: "2 3" },
              ]}
              kind="line"
              rowHeader={data.range.bucket === "day" ? "Day" : "Week"}
              totals
              isEmpty={totals!.created + totals!.won + totals!.lost === 0}
              emptyText={`No opportunities were created, won or lost between ${rangeText}.`}
              summary={
                rate ? (
                  <p className="text-sm">
                    <span className="font-medium">Win rate {rate.percent}%</span>
                    <span className="text-muted-foreground">
                      {` · ${rate.won} won of ${rate.closed} closed in this range`}
                    </span>
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Win rate appears once a deal is won or lost in the range.
                  </p>
                )
              }
            />
            <ReportChart
              id="rep-tasks"
              title="Tasks completed"
              basis="event"
              description={describe(data, "tasksCompleted")}
              rows={rows}
              series={[{ key: "completed", label: "Completed", color: "var(--chart-1)" }]}
              kind="bar"
              rowHeader={data.range.bucket === "day" ? "Day" : "Week"}
              totals
              isEmpty={totals!.completed === 0}
              emptyText={`No tasks were completed between ${rangeText}.`}
            />
            <ReportChart
              id="rep-sources"
              title="New customers by source"
              basis="event"
              description={describe(data, "customersBySource")}
              rows={sourceRows}
              series={[{ key: "count", label: "New customers", color: "var(--chart-2)" }]}
              kind="hbar"
              rowHeader="Source"
              totals
              isEmpty={noSources}
              emptyText={`No customers were added between ${rangeText}.`}
            />
            <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-4">
              <StageChart byStage={data.opportunitiesByStage} />
              <div className="flex flex-col gap-1.5">
                <BasisTag basis="current" />
                <p className="text-sm text-muted-foreground">
                  {describe(data, "opportunitiesByStage")}
                </p>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
