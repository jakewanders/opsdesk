"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { customRangeProblem, type ReportUrlState } from "../report-data";

const PRESETS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "custom", label: "Custom" },
] as const;

type Props = {
  state: ReportUrlState;
  /** The range the page is showing now, used to prefill a custom range. */
  shown: { from: string; to: string } | null;
  onChange: (change: Partial<ReportUrlState>) => void;
};

/**
 * The range control: a radio group (7, 30, 90 days, custom) and, for custom, two date fields with an Apply button. Everything
 * lands in the URL. Choosing Custom starts from the range already on screen, so it is valid at once and only needs editing.
 */
export function RangeControl({ state, shown, onChange }: Props) {
  const name = useId();
  const [from, setFrom] = useState(state.from || shown?.from || "");
  const [to, setTo] = useState(state.to || shown?.to || "");
  const [problem, setProblem] = useState<string | null>(null);
  const custom = state.range === "custom";

  function apply(event: React.FormEvent) {
    event.preventDefault();
    const issue = customRangeProblem(from, to);
    setProblem(issue);
    if (!issue) onChange({ range: "custom", from, to });
  }

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm font-medium">Date range</legend>
        <div className="inline-flex w-fit flex-wrap rounded-lg border border-border p-0.5">
          {PRESETS.map((p) => (
            <span key={p.value} className="relative">
              <input
                type="radio"
                id={`${name}-${p.value}`}
                name={name}
                value={p.value}
                checked={state.range === p.value}
                className="peer sr-only"
                onChange={() => {
                  if (p.value === "custom") {
                    setFrom(state.from || shown?.from || "");
                    setTo(state.to || shown?.to || "");
                    setProblem(null);
                    onChange({ range: "custom", from: shown?.from ?? "", to: shown?.to ?? "" });
                  } else onChange({ range: p.value, from: "", to: "" });
                }}
              />
              <label
                htmlFor={`${name}-${p.value}`}
                className={cn(
                  "inline-flex min-h-9 cursor-pointer items-center rounded-md px-3 text-sm font-medium transition-colors",
                  "hover:bg-muted peer-checked:bg-primary peer-checked:text-primary-foreground",
                  "peer-focus-visible:ring-3 peer-focus-visible:ring-ring",
                )}
              >
                {p.label}
              </label>
            </span>
          ))}
        </div>
      </fieldset>
      {custom ? (
        <form onSubmit={apply} className="flex flex-wrap items-end gap-3" noValidate>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${name}-from`} className="text-sm font-medium">
              From
            </label>
            <Input
              id={`${name}-from`}
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? `${name}-problem` : undefined}
              className="w-44"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${name}-to`} className="text-sm font-medium">
              To (included)
            </label>
            <Input
              id={`${name}-to`}
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? `${name}-problem` : undefined}
              className="w-44"
            />
          </div>
          <Button type="submit">Apply dates</Button>
          {problem ? (
            <p
              id={`${name}-problem`}
              role="alert"
              className="basis-full text-sm font-medium text-destructive"
            >
              <span className="sr-only">Error: </span>
              {problem}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
