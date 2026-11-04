"use client";

import { BarChart3, Table2 } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { usePrefersReducedMotion } from "@/lib/motion/use-prefers-reduced-motion";
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

/** Where a stage leads: the opportunities list filtered to that stage. */
export const stageHref = (stage: string) => `/app/opportunities?view=list&stage=${stage}`;

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
                {hidden ? (
                  r.label
                ) : (
                  <Link
                    href={stageHref(r.stage)}
                    className="touch-link underline-offset-4 hover:underline"
                  >
                    {r.label}
                    <span className="sr-only"> deals, open in the list</span>
                  </Link>
                )}
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
  const router = useRouter();
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
          <Impl
            rows={rows}
            animate={!reduced}
            onSelect={(stage) => router.push(stageHref(stage))}
          />
          <nav aria-label="Open a stage in the list" className="flex flex-wrap gap-1.5">
            {rows.map((r) => (
              <Link
                key={r.stage}
                href={stageHref(r.stage)}
                className="touch-link rounded-md border border-border px-2 py-0.5 text-sm underline-offset-4 hover:bg-muted"
              >
                {r.label} ({r.count})
              </Link>
            ))}
          </nav>
          <StageTable rows={rows} hidden />
        </>
      )}
    </section>
  );
}
