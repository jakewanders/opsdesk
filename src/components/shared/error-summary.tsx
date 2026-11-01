"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type ErrorSummaryItem = {
  /** `id` of the control (the same id passed to `FormField`). */
  fieldId: string;
  message: string;
};

type ErrorSummaryProps = {
  errors: readonly ErrorSummaryItem[];
  title?: string;
  /**
   * Change this (for example, a submit counter) to move focus to the summary again after another
   * failed submit. Focus moves on mount and whenever it changes.
   */
  focusKey?: number;
  className?: string;
};

/**
 * Error summary for a form submit. It is a `role="alert"` region, so screen readers announce
 * it, and it takes keyboard focus so the next Tab reaches the first error link. Each message
 * is a link that moves focus to its field.
 */
export function ErrorSummary({
  errors,
  title = "There is a problem",
  focusKey = 0,
  className,
}: ErrorSummaryProps) {
  const ref = useRef<HTMLDivElement>(null);
  const hasErrors = errors.length > 0;

  useEffect(() => {
    if (hasErrors) ref.current?.focus();
  }, [hasErrors, focusKey]);

  if (!hasErrors) return null;

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className={cn(
        "rounded-lg border border-destructive/40 bg-destructive-subtle p-4 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring",
        className,
      )}
    >
      <h2 className="font-semibold">{title}</h2>
      <ul className="mt-2 list-disc pl-5">
        {errors.map((item) => (
          <li key={item.fieldId}>
            <a
              href={`#${item.fieldId}`}
              className="font-medium underline underline-offset-2"
              onClick={(event) => {
                const field = document.getElementById(item.fieldId);
                if (field) {
                  event.preventDefault();
                  field.focus();
                }
              }}
            >
              {item.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
