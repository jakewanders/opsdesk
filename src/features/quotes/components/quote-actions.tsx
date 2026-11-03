"use client";

import { CircleCheck, CircleX, Clock, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { notify } from "@/components/shared/toast";
import { Button } from "@/components/ui/button";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiMutation } from "@/lib/api-client/use-api-mutation";
import type { QuoteStatus } from "../schema";

/**
 * Flip to true by the PDF issue (SIT-247), when `GET /api/v1/quotes/:id/pdf` exists. Until then no PDF button is rendered: there is
 * never a link to an endpoint that is not there.
 */
export const QUOTE_PDF_AVAILABLE = false;

type Target = "sent" | "approved" | "rejected" | "expired";
type Props = {
  quote: { id: string; quoteNumber: string; status: QuoteStatus; version: number };
  /** Owner, admin and member (and a demo guest in their own demo) change quote status; viewers see no buttons. */
  canWrite: boolean;
  /** In a demo, "send" is simulated: nothing is emailed. */
  isDemo: boolean;
};

const COPY: Record<
  Target,
  { button: string; Icon: typeof Send; title: (n: string) => string; confirm: string; done: string }
> = {
  sent: {
    button: "Send quote",
    Icon: Send,
    title: (n) => `Send ${n}?`,
    confirm: "Send quote",
    done: "Quote sent",
  },
  approved: {
    button: "Approve",
    Icon: CircleCheck,
    title: (n) => `Mark ${n} as approved?`,
    confirm: "Approve quote",
    done: "Quote approved",
  },
  rejected: {
    button: "Reject",
    Icon: CircleX,
    title: (n) => `Mark ${n} as rejected?`,
    confirm: "Reject quote",
    done: "Quote rejected",
  },
  expired: {
    button: "Mark expired",
    Icon: Clock,
    title: (n) => `Mark ${n} as expired?`,
    confirm: "Mark expired",
    done: "Quote marked as expired",
  },
};

/** Which status changes the quote offers from its current status (the database enforces the same table). */
export function targetsFor(status: QuoteStatus): Target[] {
  if (status === "draft") return ["sent"];
  if (status === "sent") return ["approved", "rejected", "expired"];
  return [];
}

/**
 * The status buttons of a quote (PRD 9.6): a draft can be sent; a sent quote can be approved, rejected or marked expired. Each change
 * asks first and says what it does. After it, the page is re-read, so the status, the locked fields and the history are the server's.
 * In a demo, "send" only changes the status and says so: nothing is emailed.
 */
export function QuoteActions({ quote, canWrite, isDemo }: Props) {
  const router = useRouter();
  const [target, setTarget] = useState<Target | null>(null);
  const change = useApiMutation<unknown, Target>({
    mutationFn: (to, { call }) =>
      call(`/quotes/${quote.id}/transition`, {
        method: "POST",
        json: { to, expectedVersion: quote.version },
      }),
    invalidate: [["quotes"], ["quote"], ["activity"], ["dashboard"]],
  });
  const targets = canWrite ? targetsFor(quote.status) : [];
  if (targets.length === 0) return null;

  const describe = (to: Target) => {
    if (to === "sent")
      return isDemo
        ? "This is a demo, so sending is simulated: the quote is marked as sent and nothing is emailed. Its amounts and lines will no longer be editable; a correction would be a revision. Save any edits first: unsaved changes are not part of what is sent."
        : "The quote is marked as sent. Its amounts and lines will no longer be editable; a correction would be a revision. Save any edits first: unsaved changes are not part of what is sent. Nothing is emailed from here.";
    if (to === "approved") return "Records that the customer accepted this quote.";
    if (to === "rejected") return "Records that the customer turned this quote down.";
    return "Records that this quote ran past its valid-until date without an answer.";
  };

  async function confirm() {
    if (!target) return;
    try {
      await change.mutateAsync(target);
    } catch (e) {
      throw new Error(
        isClientApiError(e)
          ? `${e.message}${e.requestId ? ` (request ${e.requestId})` : ""}`
          : "The status could not be changed. Try again.",
      );
    }
    const copy = COPY[target];
    notify.success(
      copy.done,
      target === "sent" && isDemo
        ? `${quote.quoteNumber}: simulated, nothing was emailed.`
        : quote.quoteNumber,
    );
    router.refresh();
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Quote actions">
        {targets.map((to) => {
          const { button, Icon } = COPY[to];
          return (
            <Button
              key={to}
              type="button"
              variant={to === "sent" ? "default" : "outline"}
              onClick={() => setTarget(to)}
            >
              <Icon aria-hidden="true" />
              {button}
            </Button>
          );
        })}
      </div>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title={target ? COPY[target].title(quote.quoteNumber) : ""}
        description={target ? describe(target) : ""}
        confirmLabel={target ? COPY[target].confirm : "Confirm"}
        destructive={target === "rejected"}
        onConfirm={confirm}
      />
    </>
  );
}
