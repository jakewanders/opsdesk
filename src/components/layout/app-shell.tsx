"use client";

import { Building2, Menu, Search } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { NavItem } from "./nav-config";
import { NavList } from "./nav-list";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu, type ShellUser } from "./user-menu";

type AppShellProps = {
  items: readonly NavItem[];
  children: ReactNode;
  /** Organization selector; the workspace issues replace the default label. */
  orgSelector?: ReactNode;
  user?: ShellUser | null;
  /** Rendered above the page content (guest-mode banner, SIT-211). */
  banner?: ReactNode;
};

function Brand() {
  return (
    <Link
      href="/"
      className="rounded-md px-1 text-base font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring"
    >
      OpsDesk
    </Link>
  );
}

export function AppShell({ items, children, orgSelector, user, banner }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Skip to main content
      </a>

      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-4 border-r border-sidebar-border bg-sidebar p-3 md:flex">
        <div className="flex h-9 items-center">
          <Brand />
        </div>
        <NavList items={items} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-background px-3">
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="Open navigation"
              >
                <Menu aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 gap-4 bg-sidebar p-3" showCloseButton>
              <SheetTitle className="flex h-9 items-center">OpsDesk</SheetTitle>
              <SheetDescription className="sr-only">Main navigation</SheetDescription>
              <NavList items={items} onNavigate={() => setDrawerOpen(false)} />
            </SheetContent>
          </Sheet>

          <div className="md:hidden">
            <Brand />
          </div>

          <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <Building2 aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{orgSelector ?? "Workspace"}</span>
          </div>

          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled
              className="hidden gap-2 text-muted-foreground sm:inline-flex"
              title="Search arrives with the customer list"
            >
              <Search aria-hidden="true" />
              Search
            </Button>
            <ThemeToggle />
            <UserMenu user={user} />
          </div>
        </header>

        {banner}

        <main id="main-content" tabIndex={-1} className="flex-1 p-4 outline-none md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
