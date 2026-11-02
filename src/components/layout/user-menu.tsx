"use client";

import { CircleUserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { logoutAction } from "@/lib/auth/actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type ShellUser = {
  name?: string | null;
  email?: string | null;
  /** Account state shown in the menu: a guest explores a demo; a member has an account. */
  isGuest?: boolean;
};

/** Account menu. Renders without data; the workspace issues pass the real user and actions. */
export function UserMenu({ user }: { user?: ShellUser | null }) {
  const label = user?.name || user?.email || (user?.isGuest ? "Guest" : "Not signed in");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label="Account menu">
          <CircleUserRound aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel className="truncate">{label}</DropdownMenuLabel>
        {user ? (
          <DropdownMenuLabel className="truncate pt-0 font-normal text-muted-foreground">
            {user.isGuest
              ? "Guest: exploring a demo"
              : `Member${user.email ? `: ${user.email}` : ""}`}
          </DropdownMenuLabel>
        ) : null}
        <DropdownMenuSeparator />
        {user ? (
          <form action={logoutAction}>
            <DropdownMenuItem asChild>
              <button type="submit" className="w-full cursor-pointer">
                Sign out
              </button>
            </DropdownMenuItem>
          </form>
        ) : (
          <DropdownMenuItem asChild>
            <a href="/login">Sign in</a>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
