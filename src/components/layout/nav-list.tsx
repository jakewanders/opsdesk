"use client";

import {
  Activity,
  BarChart3,
  CheckSquare,
  FileText,
  Kanban,
  LayoutDashboard,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { isActive, type NavIconName, type NavItem } from "./nav-config";

const ICONS: Record<NavIconName, LucideIcon> = {
  dashboard: LayoutDashboard,
  customers: Users,
  pipeline: Kanban,
  tasks: CheckSquare,
  quotes: FileText,
  reports: BarChart3,
  activity: Activity,
  settings: Settings,
};

type NavListProps = {
  items: readonly NavItem[];
  /** Called after a link is chosen (the mobile drawer closes itself). */
  onNavigate?: () => void;
};

function NavLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = isActive(pathname, item.href);
  const Icon = ICONS[item.icon];
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "flex min-h-9 items-center gap-2.5 rounded-md px-2.5 text-sm text-sidebar-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring",
        "hover:bg-sidebar-accent/60",
        active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
      )}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {item.label}
    </Link>
  );
}

/** Main navigation list; the footer group (Settings) sits at the bottom of the column. */
export function NavList({ items, onNavigate }: NavListProps) {
  const main = items.filter((item) => !item.footer);
  const footer = items.filter((item) => item.footer);
  return (
    <nav
      aria-label="Main"
      className="flex min-h-0 flex-1 flex-col justify-between gap-4 overflow-y-auto"
    >
      <ul className="flex flex-col gap-0.5">
        {main.map((item) => (
          <li key={item.key}>
            <NavLink item={item} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
      {footer.length > 0 && (
        <ul className="flex flex-col gap-0.5 border-t border-sidebar-border pt-2">
          {footer.map((item) => (
            <li key={item.key}>
              <NavLink item={item} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
