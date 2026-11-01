import type { FeatureFlags } from "@/lib/env/schema";

export type NavIconName =
  "dashboard" | "customers" | "pipeline" | "tasks" | "quotes" | "reports" | "activity" | "settings";

export type NavItem = {
  key: string;
  label: string;
  href: string;
  /** Icon name, resolved on the client (components cannot cross the server/client boundary). */
  icon: NavIconName;
  /** Pinned to the bottom of the sidebar. */
  footer?: boolean;
  /** Hidden when this feature flag is off. */
  flag?: keyof FeatureFlags;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/app", icon: "dashboard" },
  { key: "customers", label: "Customers", href: "/app/customers", icon: "customers" },
  { key: "pipeline", label: "Pipeline", href: "/app/opportunities", icon: "pipeline" },
  { key: "tasks", label: "Tasks", href: "/app/tasks", icon: "tasks" },
  { key: "quotes", label: "Quotes", href: "/app/quotes", icon: "quotes", flag: "quotes" },
  { key: "reports", label: "Reports", href: "/app/reports", icon: "reports" },
  { key: "activity", label: "Activity", href: "/app/activity", icon: "activity" },
  { key: "settings", label: "Settings", href: "/app/settings", icon: "settings", footer: true },
];

/**
 * Routes that have a page today. The nav never links to a page that does not exist
 * (SIT-162); each later issue that adds a page adds its href here, and
 * nav-config.test.ts checks that every listed route has a page file.
 */
export const BUILT_ROUTES: readonly string[] = ["/app"];

export function getNavItems(
  flags: Pick<FeatureFlags, "quotes">,
  builtRoutes: readonly string[] = BUILT_ROUTES,
): NavItem[] {
  return NAV_ITEMS.filter(
    (item) =>
      builtRoutes.includes(item.href) && (item.flag === undefined || flags[item.flag as "quotes"]),
  );
}

/** A nav item is current on its own path and below it; the dashboard only on `/app` itself. */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/app") return pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}
