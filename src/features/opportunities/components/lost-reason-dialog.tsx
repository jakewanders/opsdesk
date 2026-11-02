"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LOST_REASON_MAX } from "@/lib/domain/pipeline";
import type { OpportunityDto } from "../schema";

type Props = {
  deal: OpportunityDto | null;
  onCancel: () => void;
  onConfirm: (deal: OpportunityDto, reason: string) => void;
};

const TEXTAREA =
  "min-h-24 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30";

/** Lost needs a reason (the API refuses it otherwise). The form lives in a dialog that keeps focus and closes with Esc. */
export function LostReasonDialog({ deal, onCancel, onConfirm }: Props) {
  return (
    <Dialog open={deal !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        {deal ? (
          <ReasonForm key={deal.id} deal={deal} onCancel={onCancel} onConfirm={onConfirm} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ReasonForm({
  deal,
  onCancel,
  onConfirm,
}: {
  deal: OpportunityDto;
  onCancel: () => void;
  onConfirm: Props["onConfirm"];
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const text = reason.trim();
        if (text === "") return setError("Say why this deal was lost.");
        if ([...text].length > LOST_REASON_MAX)
          return setError(`The reason can be at most ${LOST_REASON_MAX} characters.`);
        onConfirm(deal, text);
      }}
      className="grid gap-4"
    >
      <DialogHeader>
        <DialogTitle>Mark as lost</DialogTitle>
        <DialogDescription>
          {deal.title} moves to Lost and its probability becomes 0%. You can reopen it later.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="lost-reason" className="text-sm font-medium">
          Why was this deal lost?
          <span aria-hidden="true" className="text-muted-foreground">
            {" "}
            *
          </span>
          <span className="sr-only">(required)</span>
        </label>
        <textarea
          id="lost-reason"
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setError(null);
          }}
          className={TEXTAREA}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "lost-reason-error" : undefined}
          aria-required
        />
        {error ? (
          <p id="lost-reason-error" className="text-sm font-medium text-destructive">
            <span className="sr-only">Error:</span> {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Mark as lost</Button>
      </DialogFooter>
    </form>
  );
}
