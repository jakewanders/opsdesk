import { AlertTriangle, CheckCircle2, Circle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Honest illustrations: real stage and field names, neutral shapes, no names, amounts, or
 * metrics. Each is decorative (aria-hidden) and wrapped in a figure whose caption says so.
 */

function Bar({ className }: { className?: string }) {
  return <div className={cn("h-2 rounded-full bg-muted", className)} />;
}

const STAGES = [
  { name: "New", cards: 2 },
  { name: "Qualified", cards: 1 },
  { name: "Proposal", cards: 2, ghost: true },
  { name: "Negotiation", cards: 1, moved: true },
  { name: "Won", cards: 1 },
] as const;

export function PipelineIllustration() {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-5 gap-2 rounded-xl border border-border bg-card p-3 sm:gap-3 sm:p-4"
    >
      {STAGES.map((stage) => (
        <div key={stage.name} className="flex min-w-0 flex-col gap-2">
          <p className="text-[0.6rem] font-medium tracking-tight text-muted-foreground sm:text-xs">
            {stage.name}
          </p>
          <div className="flex flex-col gap-2 rounded-lg bg-secondary/60 p-1.5 sm:p-2">
            {"ghost" in stage && stage.ghost ? (
              <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-primary/60 p-2">
                <Bar className="w-3/4 bg-primary/25" />
                <Bar className="w-1/2" />
              </div>
            ) : null}
            {"moved" in stage && stage.moved ? (
              <div className="flex flex-col gap-1.5 rounded-md border border-primary bg-card p-2 shadow-sm">
                <Bar className="w-3/4 bg-primary" />
                <Bar className="w-1/2" />
              </div>
            ) : null}
            {Array.from({ length: stage.cards }, (_, i) => (
              <div
                key={i}
                className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-2"
              >
                <Bar className="w-4/5" />
                <Bar className="w-2/5" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const TABS = ["Overview", "Opportunities", "Tasks", "Quotes", "Activity"];

export function CustomerIllustration() {
  return (
    <div aria-hidden="true" className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-border p-4">
        <div className="size-9 rounded-full bg-secondary" />
        <div className="flex flex-1 flex-col gap-2">
          <Bar className="w-1/3 bg-foreground/20" />
          <Bar className="w-1/4" />
        </div>
      </div>
      <div className="flex gap-1 overflow-hidden border-b border-border px-3 pt-2 text-xs">
        {TABS.map((tab, i) => (
          <span
            key={tab}
            className={cn(
              "whitespace-nowrap border-b-2 px-2 pb-2",
              i === 0
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground",
            )}
          >
            {tab}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-3 p-4">
        <Bar className="w-full" />
        <Bar className="w-5/6" />
        <Bar className="w-2/3" />
      </div>
    </div>
  );
}

type TaskRow = { label: string; state: "done" | "today" | "overdue"; icon: ReactNode };

export function TaskIllustration() {
  const rows: TaskRow[] = [
    { label: "Done", state: "done", icon: <CheckCircle2 className="size-4 text-success" /> },
    {
      label: "Due today",
      state: "today",
      icon: <Circle className="size-4 text-muted-foreground" />,
    },
    {
      label: "Overdue",
      state: "overdue",
      icon: <AlertTriangle className="size-4 text-destructive" />,
    },
  ];
  return (
    <div
      aria-hidden="true"
      className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card"
    >
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-3 p-4">
          {row.icon}
          <div className="flex flex-1 flex-col gap-2">
            <Bar className={cn("w-2/3", row.state === "done" && "opacity-60")} />
            <Bar className="w-1/3" />
          </div>
          <span
            className={cn(
              "rounded-md px-2 py-0.5 text-xs font-medium",
              row.state === "done" && "bg-success-subtle text-success",
              row.state === "today" && "bg-secondary text-secondary-foreground",
              row.state === "overdue" && "bg-destructive-subtle text-destructive",
            )}
          >
            {row.label}
          </span>
        </div>
      ))}
    </div>
  );
}

export function QuoteIllustration() {
  const lines = ["Subtotal", "Discount", "Tax"];
  return (
    <div
      aria-hidden="true"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex flex-col gap-2 border-b border-border pb-3">
        <Bar className="w-1/2 bg-foreground/20" />
        <Bar className="w-1/3" />
      </div>
      {lines.map((line) => (
        <div
          key={line}
          className="flex items-center justify-between gap-4 text-sm text-muted-foreground"
        >
          <span>{line}</span>
          <Bar className="w-20" />
        </div>
      ))}
      <div className="flex items-center justify-between gap-4 border-t border-border pt-3 text-sm font-medium">
        <span>Total</span>
        <Bar className="w-24 bg-primary" />
      </div>
    </div>
  );
}
