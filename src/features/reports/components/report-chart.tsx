"use client";

import { BarChart3, Table2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "../use-reduced-motion";
import type { ChartKind, ChartRow, ChartSeries } from "./series-chart-impl";

// Recharts is fetched only when a chart is about to be drawn.
const Impl = dynamic(() => import("./series-chart-impl"), {
  ssr: false,
  loading: () => (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading the chart</span>
      <div aria-hidden="true" className="h-64 animate-pulse rounded-lg bg-muted" />
    </div>
  ),
});

export type ReportChartProps = {
  id: string;
  title: string;
  /** `event`: counted on the day each thing happened, inside the range. `current`: where things stand now, whatever the range. */
  basis: "event" | "current";
  /** The metric's plain-language description from the API. */
  description: string;
  rows: ChartRow[];
  series: ChartSeries[];
  kind: ChartKind;
  /** Header of the first table column ("Day", "Source"). */
  rowHeader: string;
  /** Show a total row in the table (sums of each series). */
  totals?: boolean;
  /** When true no chart is drawn: the sentence below explains why. */
  isEmpty: boolean;
  emptyText: string;
  /** A figure that belongs to this chart, shown under the description (for example the win rate). */
  summary?: ReactNode;
};

const BASIS_LABEL = {
  event: "Counted on the day it happened",
  current: "As of right now",
} as const;

/** Basis tag: words first, so it never relies on colour. */
export function BasisTag({ basis }: { basis: "event" | "current" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        basis === "event"
          ? "border-border text-foreground"
          : "border-dashed border-border text-muted-foreground",
      )}
    >
      {BASIS_LABEL[basis]}
    </span>
  );
}

function DataTable({
  rows,
  series,
  rowHeader,
  title,
  totals,
  hidden,
}: Pick<ReportChartProps, "rows" | "series" | "rowHeader" | "title" | "totals"> & {
  hidden?: boolean;
}) {
  return (
    <div className={hidden ? "sr-only" : "max-h-80 overflow-auto rounded-lg border border-border"}>
      <table className="w-full text-left text-sm">
        <caption className={hidden ? undefined : "sr-only"}>{title}, as a table</caption>
        <thead className="sticky top-0 border-b border-border bg-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {rowHeader}
            </th>
            {series.map((s) => (
              <th key={s.key} scope="col" className="px-3 py-2 text-right font-medium">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r.label)} className="border-b border-border last:border-0">
              <th scope="row" className="px-3 py-2 font-normal">
                {r.label}
              </th>
              {series.map((s) => (
                <td key={s.key} className="px-3 py-2 text-right tabular-nums">
                  {r[s.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {totals ? (
          <tfoot className="border-t border-border bg-muted/50">
            <tr>
              <th scope="row" className="px-3 py-2 font-medium">
                Total
              </th>
              {series.map((s) => (
                <td key={s.key} className="px-3 py-2 text-right font-medium tabular-nums">
                  {rows.reduce((n, r) => n + Number(r[s.key]), 0)}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

/**
 * One report chart: title, a tag saying what it is counted on, the metric's description, the chart, and the same numbers as a table
 * (visible on request, always present for screen readers). With nothing in the range there is no chart, only a sentence.
 */
export function ReportChart(props: ReportChartProps) {
  const {
    id,
    title,
    basis,
    description,
    rows,
    series,
    kind,
    rowHeader,
    totals,
    isEmpty,
    emptyText,
    summary,
  } = props;
  const [asTable, setAsTable] = useState(false);
  const reduced = usePrefersReducedMotion();
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 id={`${id}-title`} className="text-lg font-semibold">
            {title}
          </h2>
          <BasisTag basis={basis} />
        </div>
        {isEmpty ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={asTable}
            onClick={() => setAsTable((v) => !v)}
          >
            {asTable ? <BarChart3 aria-hidden="true" /> : <Table2 aria-hidden="true" />}
            {asTable ? "View as chart" : "View as table"}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
      {summary}
      {isEmpty ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {emptyText}
        </p>
      ) : asTable ? (
        <DataTable
          rows={rows}
          series={series}
          rowHeader={rowHeader}
          title={title}
          totals={totals}
        />
      ) : (
        <>
          <Impl rows={rows} series={series} kind={kind} animate={!reduced} />
          <DataTable
            rows={rows}
            series={series}
            rowHeader={rowHeader}
            title={title}
            totals={totals}
            hidden
          />
        </>
      )}
    </section>
  );
}
