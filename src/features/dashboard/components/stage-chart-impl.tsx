"use client";

import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { useState } from "react";
import { barOpacity } from "./bar-emphasis";
import type { StageRow } from "./stage-data";

/** Open stages share one token colour; won and lost differ, and every bar also carries its stage name and numbers as text. */
const FILL: Record<string, string> = {
  won: "var(--chart-2)",
  lost: "var(--chart-5)",
};

type Props = { rows: StageRow[]; animate: boolean; onSelect?: (stage: string) => void };

/**
 * Recharts is loaded only when this file is (see `stage-chart.tsx`). Bars are deal counts; each bar has a direct text label
 * "N deals, $amount", so no meaning rests on colour. It reads only the rows it is given (the dashboard payload).
 */
export default function StageChartImpl({ rows, animate, onSelect }: Props) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const [active, setActive] = useState<string | null>(null);
  return (
    <div className="h-72 w-full" aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 140, bottom: 4, left: 4 }}>
          <XAxis type="number" hide domain={[0, max]} />
          <YAxis
            type="category"
            dataKey="label"
            width={96}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--foreground)", fontSize: 13 }}
          />
          <Bar
            dataKey="count"
            radius={4}
            isAnimationActive={animate}
            barSize={22}
            minPointSize={3}
            cursor={onSelect ? "pointer" : undefined}
            onClick={(bar: { stage?: string }) => bar.stage && onSelect?.(bar.stage)}
            onMouseEnter={(bar: { stage?: string }) => setActive(bar.stage ?? null)}
            onMouseLeave={() => setActive(null)}
          >
            {rows.map((r) => (
              <Cell
                key={r.stage}
                fill={FILL[r.stage] ?? "var(--chart-1)"}
                fillOpacity={barOpacity(active, r.stage)}
                style={{ transition: "fill-opacity var(--motion-fast) var(--ease-out)" }}
              />
            ))}
            <LabelList
              dataKey="valueLabel"
              position="right"
              fill="var(--foreground)"
              fontSize={13}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
