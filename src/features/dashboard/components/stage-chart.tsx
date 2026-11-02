"use client";

import { BarChart3, Table2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useSyncExternalStore, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatUsd } from "@/lib/money/format";
import type { DashboardDto } from "../service";
import { stageRows, type StageRow } from "./stage-data";

// Recharts (the heaviest dependency on this page) is fetched only when the chart is about to be drawn.
const Impl = dynamic(() => import("./stage-chart-impl"), {
  ssr: false,
  loading: () => (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading the chart</span>
      <div aria-hidden="true" className="h-72 animate-pulse rounded-lg bg-muted" />
    </div>
  ),
});

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const q = window.matchMedia("(prefers-reduced-motion: reduce)");
      q.addEventListener("change", notify);
      return () => q.removeEventListener("change", notify);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => true,
  );
}

function StageTable({ rows, hidden }: { rows: StageRow[]; hidden?: boolean }) {
  const total = rows.reduce((n, r) => n + r.count, 0);
  return (
    <div className={hidden ? "sr-only" : "overflow-x-auto rounded-lg border border-border"}>
      <table className="w-full text-left text-sm">
        <caption className={hidden ? undefined : "sr-only"}>
          Opportunities by stage: {total} in total
        </caption>
        <thead className="border-b border-border bg-muted/50">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Stage
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Deals
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.stage} className="border-b border-border last:border-0">
              <th scope="row" className="px-3 py-2 font-normal">
                {r.label}
              </th>
              <td className="px-3 py-2 text-right tabular-nums">{r.count}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatUsd(r.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Opportunities by stage: a bar per stage (count, with "N deals, $amount" written on each bar) and the same numbers as a
 * table. "View as table" swaps the chart for the visible table; while the chart is showing, an identical table is
 * available to screen readers. With no opportunities there is no chart at all, only a sentence.
 */
export function StageChart({ byStage }: { byStage: DashboardDto["opportunitiesByStage"] }) {
  const rows = stageRows(byStage);
  const [asTable, setAsTable] = useState(false);
  const reduced = usePrefersReducedMotion();
  const empty = rows.every((r) => r.count === 0);

  return (
    <section aria-labelledby="dash-stage" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="dash-stage" className="text-lg font-semibold">
          Opportunities by stage
        </h2>
        {empty ? null : (
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
      {empty ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          No opportunities yet. Add a deal and it appears here by stage.
        </p>
      ) : asTable ? (
        <StageTable rows={rows} />
      ) : (
        <>
          <Impl rows={rows} animate={!reduced} />
          <StageTable rows={rows} hidden />
        </>
      )}
    </section>
  );
}
