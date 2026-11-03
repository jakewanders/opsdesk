"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type ChartSeries = { key: string; label: string; color: string; dash?: string };
export type ChartRow = Record<string, string | number>;
export type ChartKind = "line" | "bar" | "hbar";

type Props = { rows: ChartRow[]; series: ChartSeries[]; kind: ChartKind; animate: boolean };

const TICK = { fill: "var(--muted-foreground)", fontSize: 12 };
const TOOLTIP = {
  contentStyle: {
    background: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    fontSize: 13,
  },
};

/**
 * Recharts, loaded only when a chart is drawn (see `report-chart.tsx`). It draws exactly the rows it is given, which are the API's
 * buckets; every chart also has a table with the same numbers. Colours are the theme's chart tokens and lines differ by dash and
 * marker as well, so no meaning rests on colour alone.
 */
export default function SeriesChartImpl({ rows, series, kind, animate }: Props) {
  if (kind === "line") {
    return (
      <div className="h-64 w-full" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="label" tick={TICK} tickLine={false} minTickGap={24} />
            <YAxis allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} />
            <Tooltip {...TOOLTIP} />
            <Legend wrapperStyle={{ fontSize: 13 }} />
            {series.map((s, i) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray={s.dash}
                dot={{ r: 3, strokeWidth: 0, fill: s.color }}
                activeDot={{ r: 5 }}
                isAnimationActive={animate}
                type="monotone"
                legendType={i === 0 ? "line" : "plainline"}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }
  if (kind === "bar") {
    const s = series[0];
    return (
      <div className="h-64 w-full" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="label" tick={TICK} tickLine={false} minTickGap={24} />
            <YAxis allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} />
            <Tooltip {...TOOLTIP} cursor={{ fill: "var(--muted)" }} />
            <Bar
              dataKey={s.key}
              name={s.label}
              fill={s.color}
              radius={[3, 3, 0, 0]}
              isAnimationActive={animate}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }
  const s = series[0];
  const max = Math.max(1, ...rows.map((r) => Number(r[s.key])));
  return (
    <div className="h-56 w-full" aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 4 }}>
          <XAxis type="number" hide domain={[0, max]} />
          <YAxis
            type="category"
            dataKey="label"
            width={84}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--foreground)", fontSize: 13 }}
          />
          <Bar
            dataKey={s.key}
            name={s.label}
            fill={s.color}
            radius={4}
            barSize={22}
            minPointSize={3}
            isAnimationActive={animate}
          >
            <LabelList dataKey={s.key} position="right" fill="var(--foreground)" fontSize={13} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
