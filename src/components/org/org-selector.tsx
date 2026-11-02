"use client";

import { Check, ChevronsUpDown, Plus } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { WorkspaceSummary } from "@/lib/api/organizations";

type Props = {
  workspaces: readonly WorkspaceSummary[];
  /** The active workspace id, or null when the user still has to choose. */
  activeId: string | null;
  /** Server action that remembers the choice (re-verified against memberships). */
  selectAction: (formData: FormData) => Promise<void>;
  /** Members may create more workspaces; guests may not. */
  canCreate: boolean;
};

/**
 * Top-bar workspace selector. A menu of the caller's own workspaces: choosing one submits a form to a server action
 * that checks membership, so the list is a convenience and never authorization. A single workspace for a guest is
 * shown as plain text. Keyboard: arrow keys move, Enter chooses, Escape closes (Radix menu).
 */
export function OrgSelector({ workspaces, activeId, selectAction, canCreate }: Props) {
  const active = workspaces.find((w) => w.id === activeId) ?? null;
  if (workspaces.length <= 1 && !canCreate) {
    return (
      <span className="truncate font-medium text-foreground">{active?.name ?? "Workspace"}</span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="max-w-64 gap-1 px-2 font-medium text-foreground"
          aria-label={`Workspace: ${active?.name ?? "none selected"}. Change workspace`}
        >
          <span className="truncate">{active?.name ?? "Choose a workspace"}</span>
          <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">
        <DropdownMenuLabel>Your workspaces</DropdownMenuLabel>
        {workspaces.map((w) => (
          <form key={w.id} action={selectAction}>
            <input type="hidden" name="orgId" value={w.id} />
            <DropdownMenuItem asChild>
              <button
                type="submit"
                className="flex w-full cursor-pointer items-center justify-between gap-3"
                aria-current={w.id === activeId ? "true" : undefined}
              >
                <span className="truncate">
                  {w.name}
                  {w.kind === "demo" ? (
                    <span className="ml-2 text-xs text-muted-foreground">demo</span>
                  ) : null}
                </span>
                {w.id === activeId ? (
                  <Check aria-hidden="true" className="size-4 shrink-0" />
                ) : null}
              </button>
            </DropdownMenuItem>
          </form>
        ))}
        {canCreate ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/app/setup" className="flex items-center gap-2">
                <Plus aria-hidden="true" className="size-4" />
                Create workspace
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
