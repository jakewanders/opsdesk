"use client";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { listLabels } from "@/lib/api-client/conflict";
import type { ConflictAnalysis } from "@/lib/api-client/conflict";

/** The part of `useConflict`'s result the dialog needs (so it does not depend on a form's value type). */
export type ConflictControls = {
  state:
    | { status: "loading" }
    | { status: "failed" }
    | { status: "ready"; analysis: ConflictAnalysis }
    | null;
  close: () => void;
  reloadLatest: () => void;
  applyOnTop: () => void;
  copyMine: () => void | Promise<void>;
};

type Props = {
  /** What the record is, lower case: "customer", "task", "quote", "workspace settings". */
  noun: string;
  labels: Record<string, string>;
  conflict: ConflictControls;
};

/**
 * The one stale-edit dialog (PRD 7.5): customer, opportunity, task, quote and workspace settings all show this. It opens when a save
 * came back 409, says someone (possibly in another tab) changed the record, names the fields that changed on each side (field names
 * only, never their contents), and offers: Reload latest (discard mine), Apply my changes on top (only when we did not change the same
 * field), Keep editing (nothing is touched; saving again will conflict again instead of overwriting), and Copy my changes. It is an
 * alert dialog: announced when it opens, focus moves into it, Tab stays inside, and focus returns to the form on close.
 */
export function ConflictDialog({ noun, labels, conflict }: Props) {
  const { state, close, reloadLatest, applyOnTop, copyMine } = conflict;
  return (
    <AlertDialog open={state !== null} onOpenChange={(open) => !open && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Someone else changed this {noun}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2 text-sm text-muted-foreground">
              <p>
                It was saved by someone else, possibly in another tab, after you opened it. Your
                changes were not saved, and nothing was overwritten.
              </p>
              {state?.status === "loading" ? <p role="status">Checking what changed…</p> : null}
              {state?.status === "failed" ? (
                <p role="alert">
                  The latest version could not be loaded. Keep editing and try saving again, or
                  reload the page.
                </p>
              ) : null}
              {state?.status === "ready" ? (
                <>
                  <p>
                    <span className="font-medium text-foreground">Changed by them:</span>{" "}
                    {state.analysis.byOthers.length > 0
                      ? listLabels(labels, state.analysis.byOthers)
                      : "nothing in the fields you can edit here"}
                    .
                  </p>
                  <p>
                    <span className="font-medium text-foreground">Changed by you:</span>{" "}
                    {state.analysis.mine.length > 0
                      ? listLabels(labels, state.analysis.mine)
                      : "nothing"}
                    .
                  </p>
                  {state.analysis.overlap.length > 0 ? (
                    <p>
                      You both changed {listLabels(labels, state.analysis.overlap)}, so your changes
                      cannot be put on top without replacing theirs. Reload the latest version and
                      redo them, or keep editing and copy them first.
                    </p>
                  ) : state.analysis.canApplyOnTop ? (
                    <p>
                      You changed different fields, so your changes can go on top of the latest
                      version. You will review them before saving.
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-wrap gap-2 sm:justify-end">
          <Button type="button" variant="outline" onClick={close}>
            Keep editing
          </Button>
          {state?.status === "ready" && state.analysis.mine.length > 0 ? (
            <Button type="button" variant="outline" onClick={() => void copyMine()}>
              Copy my changes
            </Button>
          ) : null}
          {state?.status === "ready" && state.analysis.canApplyOnTop ? (
            <Button type="button" variant="outline" onClick={applyOnTop}>
              Apply my changes on top
            </Button>
          ) : null}
          <Button type="button" disabled={state?.status !== "ready"} onClick={reloadLatest}>
            Reload latest
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
