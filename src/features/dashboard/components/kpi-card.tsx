import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { useCountUp } from "@/lib/motion/use-count-up";
import { cn } from "@/lib/utils";

type Props = {
  label: string;
  value: string;
  /** Where the card leads: the list this number counts, already filtered. */
  href: string;
  icon: LucideIcon;
  /** The exact figure for tooltips and assistive tech when `value` is rounded. */
  exact?: string;
  /** Marks a number that needs attention (overdue). Conveyed with an icon and words as well as colour. */
  attention?: boolean;
  /** Extra words for the link's accessible name, for example "View overdue tasks". */
  action: string;
  /**
   * The figure behind `value`, so the number can count up on first load and tween when it changes. `format` must produce
   * `value` for the same figure. Without it, `value` is shown as is.
   */
  numeric?: { amount: number; format: (n: number) => string; fromZero: boolean };
};

/**
 * One KPI: a whole-card link whose name reads "Label, value. Action". The number is the stored count or sum, nothing
 * derived or trended.
 */
export function KpiCard({
  label,
  value,
  href,
  icon: Icon,
  exact,
  attention,
  action,
  numeric,
}: Props) {
  const counted = useCountUp(numeric?.amount ?? 0, { fromZero: numeric?.fromZero ?? false });
  const shown = numeric ? numeric.format(Math.round(counted)) : value;
  return (
    <Link
      href={href}
      title={exact}
      className="group flex min-h-24 flex-col justify-between gap-2 rounded-lg border border-border p-4 outline-none transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring"
    >
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {label}
      </span>
      <span
        className={cn(
          "text-2xl font-semibold tracking-tight tabular-nums",
          attention && "text-destructive",
        )}
      >
        {shown}
        {attention ? <span className="sr-only">needs attention</span> : null}
      </span>
      <span className="sr-only">{action}</span>
    </Link>
  );
}
