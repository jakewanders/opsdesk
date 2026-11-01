import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@/components/layout/nav-config";
import { FLAGGED_ROUTES, ROUTES } from "@/lib/routes";

const APP_DIR = join(process.cwd(), "src/app");

/** Route groups like (marketing) do not appear in URLs, so search every group for the path. */
function hasRouteFile(path: string): boolean {
  const segments = path === "/" ? [] : path.slice(1).split("/");
  const groups = ["", "(marketing)", "(auth)"];
  return groups.some((group) =>
    ["page.tsx", "route.ts"].some((file) => existsSync(join(APP_DIR, group, ...segments, file))),
  );
}

describe("route map (PRD 3.3)", () => {
  it("has no duplicates", () => {
    expect(new Set(ROUTES.map((r) => r.path)).size).toBe(ROUTES.length);
  });

  it.each(ROUTES.map((r) => r.path))("%s has a page or route handler", (path) => {
    expect(hasRouteFile(path)).toBe(true);
  });

  it("covers every PRD 3.3 route", () => {
    const expected = [
      "/",
      "/demo",
      "/login",
      "/signup",
      "/auth/callback",
      "/forgot-password",
      "/reset-password",
      "/privacy",
      "/terms",
      "/app",
      "/app/customers",
      "/app/customers/new",
      "/app/customers/[id]",
      "/app/opportunities",
      "/app/opportunities/[id]",
      "/app/tasks",
      "/app/quotes",
      "/app/quotes/new",
      "/app/quotes/[id]",
      "/app/reports",
      "/app/activity",
      "/app/settings/organization",
      "/app/settings/members",
      "/app/settings/integrations",
      "/app/settings/billing",
    ];
    for (const path of expected) {
      expect(ROUTES.map((r) => r.path)).toContain(path);
    }
  });

  it("only P2 routes are flag-gated", () => {
    expect(FLAGGED_ROUTES.map((r) => r.path)).toEqual([
      "/app/settings/integrations",
      "/app/settings/billing",
    ]);
  });

  it("never links the sidebar to a missing page", () => {
    const known = new Set(ROUTES.map((r) => r.path));
    for (const item of NAV_ITEMS) {
      expect(known.has(item.href), item.href).toBe(true);
      expect(hasRouteFile(item.href), item.href).toBe(true);
    }
  });
});
