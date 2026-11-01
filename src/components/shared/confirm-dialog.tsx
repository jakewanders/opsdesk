"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ErrorAlert } from "./error-alert";

type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What will happen and whether it can be undone. */
  description: ReactNode;
  /** The verb on the confirm button, for example "Archive customer". Never "OK" or "Yes". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  destructive?: boolean;
  /**
   * Runs when the person confirms. The dialog stays open and shows the failure if it throws,
   * and closes when it resolves.
   */
  onConfirm: () => void | Promise<void>;
};

/**
 * Confirmation for destructive actions, built on an alert dialog: focus moves to Cancel when
 * it opens, Tab stays inside, and focus returns to the control that opened it. Esc and
 * Cancel close it. While `onConfirm` is running the action is critical: Esc is ignored and
 * both buttons are disabled, so the request cannot be abandoned or sent twice.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = true,
  onConfirm,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  // Radix only restores focus to its own <Trigger>. This dialog is controlled (opened from any
  // button or menu item), so remember the element that had focus when it opened, before the
  // dialog moves focus inside, and give focus back to it on close.
  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement) {
      returnFocusTo.current = document.activeElement;
    }
  }, [open]);

  async function handleConfirm() {
    setPending(true);
    setFailure(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The action could not be completed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) setFailure(null);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent
        onEscapeKeyDown={(event) => pending && event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusTo.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {failure ? <ErrorAlert title="Could not complete the action" message={failure} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
