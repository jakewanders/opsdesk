import { afterEach, describe, expect, it, vi } from "vitest";
import robots from "./robots";
import sitemap from "./sitemap";

afterEach(() => vi.unstubAllEnvs());

describe("robots.txt", () => {
  it("in production opens the public pages and closes the app, the account pages, the API and the demo entry", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://opsdesk.sitelaunch.dev");
    vi.stubEnv("CONTEXT", "production");
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rule.allow).toBe("/");
    for (const p of ["/app", "/api/", "/auth/", "/demo", "/login", "/signup", "/reset-password"])
      expect(rule.disallow).toContain(p);
    expect(r.sitemap).toBe("https://opsdesk.sitelaunch.dev/sitemap.xml");
  });
  it("on a preview or a branch deploy disallows everything and names no sitemap", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://opsdesk.sitelaunch.dev");
    for (const context of ["deploy-preview", "branch-deploy"]) {
      vi.stubEnv("CONTEXT", context);
      const r = robots();
      expect(r.rules).toEqual({ userAgent: "*", disallow: "/" });
      expect(r.sitemap).toBeUndefined();
    }
  });
});

describe("sitemap.xml", () => {
  it("lists only the public pages, on the configured origin (never localhost or the netlify.app host)", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://opsdesk.sitelaunch.dev");
    expect(sitemap().map((e) => e.url)).toEqual([
      "https://opsdesk.sitelaunch.dev/",
      "https://opsdesk.sitelaunch.dev/privacy",
      "https://opsdesk.sitelaunch.dev/terms",
    ]);
  });
});
