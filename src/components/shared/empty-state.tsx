import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type EmptyStateProps = {
  /** What is empty, for example "No customers yet". */
  title: string;
  /** Why it is empty and what the person can do about it. */
  description: ReactNode;
  /** Call to action: a button or link that creates the first record. */
  action?: ReactNode;
  /** Decorative icon (lucide). Hidden from assistive tech. */
  icon?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
};

/** An empty list or section. Always explains the situation and offers the next step. */
export function EmptyState({
  title,
  description,
  action,
  icon,
  headingLevel = 2,
  className,
}: EmptyStateProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center",
        className,
      )}
    >
      {icon ? (
        <div aria-hidden="true" className="text-muted-foreground [&_svg]:size-8">
          {icon}
        </div>
      ) : null}
      <Heading className="text-base font-semibold">{title}</Heading>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </section>
  );
}
