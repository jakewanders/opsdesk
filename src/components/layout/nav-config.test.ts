import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_ROUTES, NAV_ITEMS, getNavItems, isActive } from "./nav-config";

const ALL = NAV_ITEMS.map((item) => item.href);
const flags = { quotes: true };

describe("getNavItems", () => {
  it("only lists routes that are built", () => {
    expect(getNavItems(flags).map((i) => i.href)).toEqual(
      BUILT_ROUTES.filter((r) => ALL.includes(r)),
    );
  });

  it("lists all seven sections plus Settings when everything is built", () => {
    expect(getNavItems(flags, ALL).map((i) => i.label)).toEqual([
      "Dashboard",
      "Customers",
      "Pipeline",
      "Tasks",
      "Quotes",
      "Reports",
      "Activity",
      "Settings",
    ]);
  });

  it("hides Quotes when the quotes flag is off", () => {
    const labels = getNavItems({ quotes: false }, ALL).map((i) => i.label);
    expect(labels).not.toContain("Quotes");
    expect(labels).toContain("Reports");
  });

  it("puts Settings in the footer group", () => {
    expect(NAV_ITEMS.filter((i) => i.footer).map((i) => i.label)).toEqual(["Settings"]);
  });
});

describe("BUILT_ROUTES", () => {
  it.each(BUILT_ROUTES)("%s has a page file", (route) => {
    const dir = join(process.cwd(), "src/app", route);
    expect(existsSync(join(dir, "page.tsx"))).toBe(true);
  });
});

describe("isActive", () => {
  it("matches the dashboard only on /app", () => {
    expect(isActive("/app", "/app")).toBe(true);
    expect(isActive("/app/customers", "/app")).toBe(false);
  });
  it("matches a section and its children, not look-alikes", () => {
    expect(isActive("/app/customers", "/app/customers")).toBe(true);
    expect(isActive("/app/customers/123", "/app/customers")).toBe(true);
    expect(isActive("/app/customers-archive", "/app/customers")).toBe(false);
  });
});
