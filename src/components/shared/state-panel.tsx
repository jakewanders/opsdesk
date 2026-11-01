import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type StatePanelProps = {
  title: string;
  /** Plain-language explanation of what is shown and what to do next. */
  description: ReactNode;
  /** Links or buttons. */
  actions?: ReactNode;
  headingLevel?: 1 | 2;
  className?: string;
};

/**
 * Base layout for "nothing here yet", not-found, and error screens. SIT-163 builds the rest
 * of the shared state components (skeleton, toast, confirm dialog) on top of this.
 */
export function StatePanel({
  title,
  description,
  actions,
  headingLevel = 1,
  className,
}: StatePanelProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <div className={cn("flex max-w-xl flex-col gap-3", className)}>
      <Heading className="text-2xl font-semibold tracking-tight">{title}</Heading>
      <div className="text-muted-foreground">{description}</div>
      {actions ? <div className="mt-2 flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
