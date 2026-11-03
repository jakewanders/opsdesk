/**
 * Every route in PRD 3.3. Drives the route smoke test, the nav test, and `npm run smoke:routes`.
 * `sample` replaces dynamic segments. `flag` marks P2 routes that 404 while the flag is off.
 */
import type { FeatureFlags } from "@/lib/env/schema";

export type RouteSpec = {
  path: string;
  group: "public" | "app";
  /** Path with dynamic segments filled in, used by the smoke test. */
  sample?: string;
  flag?: keyof FeatureFlags;
};

const ID = "00000000-0000-0000-0000-000000000000";

export const ROUTES: readonly RouteSpec[] = [
  { path: "/", group: "public" },
  { path: "/demo", group: "public" },
  { path: "/login", group: "public" },
  { path: "/signup", group: "public" },
  { path: "/auth/callback", group: "public" },
  { path: "/forgot-password", group: "public" },
  { path: "/reset-password", group: "public" },
  { path: "/privacy", group: "public" },
  { path: "/terms", group: "public" },
  { path: "/app", group: "app" },
  { path: "/app/customers", group: "app" },
  { path: "/app/customers/new", group: "app" },
  { path: "/app/customers/import", group: "app" },
  { path: "/app/customers/[id]", group: "app", sample: `/app/customers/${ID}` },
  { path: "/app/opportunities", group: "app" },
  { path: "/app/opportunities/[id]", group: "app", sample: `/app/opportunities/${ID}` },
  { path: "/app/tasks", group: "app" },
  { path: "/app/quotes", group: "app" },
  { path: "/app/quotes/new", group: "app" },
  { path: "/app/quotes/[id]", group: "app", sample: `/app/quotes/${ID}` },
  { path: "/app/reports", group: "app" },
  { path: "/app/activity", group: "app" },
  { path: "/app/settings", group: "app" },
  { path: "/app/settings/organization", group: "app" },
  { path: "/app/settings/members", group: "app" },
  { path: "/app/settings/integrations", group: "app", flag: "integrations" },
  { path: "/app/settings/billing", group: "app", flag: "billing" },
];

/** Paths guarded by a P2 flag (proxy.ts returns 404 when the flag is off). */
export const FLAGGED_ROUTES = ROUTES.filter((r) => r.flag !== undefined) as (RouteSpec & {
  flag: keyof FeatureFlags;
})[];
