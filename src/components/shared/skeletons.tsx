import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type SkeletonFrameProps = {
  /** Spoken to screen reader users, for example "Loading customers". */
  label: string;
  className?: string;
  children: React.ReactNode;
};

/**
 * One polite status per loading area. The blocks inside are decoration and hidden from
 * assistive tech, so a table of 8 skeleton rows is announced once, not 40 times.
 */
function SkeletonFrame({ label, className, children }: SkeletonFrameProps) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

type TableSkeletonProps = {
  rows?: number;
  columns?: number;
  label?: string;
  className?: string;
};

/** Placeholder for a data table while its first page loads. */
export function TableSkeleton({
  rows = 8,
  columns = 5,
  label = "Loading table",
  className,
}: TableSkeletonProps) {
  return (
    <SkeletonFrame label={label} className={cn("w-full", className)}>
      <div className="flex flex-col gap-2">
        <div className="flex gap-4 border-b border-border pb-2">
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex gap-4 py-1.5">
            {Array.from({ length: columns }, (_, c) => (
              <Skeleton key={c} className={cn("h-4 flex-1", c === 0 && "max-w-[40%]")} />
            ))}
          </div>
        ))}
      </div>
    </SkeletonFrame>
  );
}

type CardSkeletonProps = { count?: number; label?: string; className?: string };

/** Placeholder for KPI cards or record cards. */
export function CardSkeleton({ count = 1, label = "Loading", className }: CardSkeletonProps) {
  return (
    <SkeletonFrame label={label} className={className}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-7 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </SkeletonFrame>
  );
}

type ChartSkeletonProps = { label?: string; className?: string };

/** Placeholder for a chart area. Fixed height so the page does not jump when data arrives. */
export function ChartSkeleton({ label = "Loading chart", className }: ChartSkeletonProps) {
  const bars = [55, 80, 40, 95, 65, 30, 72];
  return (
    <SkeletonFrame label={label} className={className}>
      <div className="flex h-56 items-end gap-3 rounded-lg border border-border bg-card p-4">
        {bars.map((height, i) => (
          <Skeleton key={i} className="flex-1" style={{ height: `${height}%` }} />
        ))}
      </div>
    </SkeletonFrame>
  );
}
