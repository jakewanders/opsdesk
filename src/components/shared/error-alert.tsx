import { OctagonAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { ApiErrorBody } from "@/lib/api/types";
import { cn } from "@/lib/utils";

type ErrorAlertProps = {
  /** Short heading. Default "Something went wrong". */
  title?: string;
  /** What happened and what to do next. Use this or `error`. */
  message?: ReactNode;
  /** An API error envelope body; supplies the message and request ID. */
  error?: Pick<ApiErrorBody, "message"> & Partial<Omit<ApiErrorBody, "message">>;
  /** Request ID to quote to support. Overrides the one in `error`. */
  requestId?: string;
  /** Shows a "Try again" button. */
  onRetry?: () => void;
  className?: string;
};

/**
 * An actionable error. `role="alert"` makes screen readers announce it as soon as it appears.
 * The request ID is shown so a person can quote it in a report.
 */
export function ErrorAlert({
  title = "Something went wrong",
  message,
  error,
  requestId,
  onRetry,
  className,
}: ErrorAlertProps) {
  const id = requestId ?? error?.requestId;
  const body = message ?? error?.message;
  return (
    <div
      role="alert"
      className={cn(
        "flex gap-3 rounded-lg border border-destructive/40 bg-destructive-subtle p-4 text-sm text-foreground",
        className,
      )}
    >
      <OctagonAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold">{title}</p>
        {body ? <div>{body}</div> : null}
        {id ? (
          <p className="text-muted-foreground">
            Request ID: <code className="font-mono text-foreground">{id}</code>
          </p>
        ) : null}
        {onRetry ? (
          <div className="mt-2">
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
