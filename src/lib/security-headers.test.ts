import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, buildSecurityHeaders } from "./security-headers";

const SUPA = "https://yfldagjajwflvervmwtq.supabase.co";
const csp = (o = {}) =>
  buildContentSecurityPolicy({ supabaseUrl: `${SUPA}/`, production: true, ...o });
const directive = (policy: string, name: string) =>
  policy.split("; ").find((d) => d.startsWith(`${name} `) || d === name);

describe("Content-Security-Policy", () => {
  it("allows scripts from this site and Turnstile only (no eval, no wildcard)", () => {
    const d = directive(csp(), "script-src")!;
    expect(d).toBe("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com");
    expect(csp()).not.toMatch(/unsafe-eval|\*/);
  });
  it("lets the browser call this site, the one Supabase project and Turnstile, nothing else", () => {
    expect(directive(csp(), "connect-src")).toBe(
      `connect-src 'self' ${SUPA} https://challenges.cloudflare.com`,
    );
    expect(directive(csp({ supabaseUrl: "http://127.0.0.1:54321" }), "connect-src")).toContain(
      "http://127.0.0.1:54321",
    );
    expect(directive(csp({ supabaseUrl: "not a url" }), "connect-src")).toBe(
      "connect-src 'self' https://challenges.cloudflare.com",
    );
  });
  it("forbids framing, objects, a changed base URL and cross-site form posts", () => {
    const p = csp();
    expect(directive(p, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(p, "object-src")).toBe("object-src 'none'");
    expect(directive(p, "base-uri")).toBe("base-uri 'self'");
    expect(directive(p, "form-action")).toBe("form-action 'self'");
    expect(directive(p, "frame-src")).toBe("frame-src https://challenges.cloudflare.com");
    expect(directive(p, "default-src")).toBe("default-src 'self'");
  });
  it("upgrades insecure requests in production only", () => {
    expect(csp()).toContain("upgrade-insecure-requests");
    expect(csp({ production: false })).not.toContain("upgrade-insecure-requests");
  });
});

describe("buildSecurityHeaders", () => {
  const names = (hs: { key: string }[]) => hs.map((h) => h.key);
  it("sends the full set in production", () => {
    const hs = buildSecurityHeaders({ supabaseUrl: SUPA, production: true });
    expect(names(hs)).toEqual([
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Content-Security-Policy",
    ]);
    const v = Object.fromEntries(hs.map((h) => [h.key, h.value]));
    expect(v["X-Frame-Options"]).toBe("DENY");
    expect(v["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(v["Permissions-Policy"]).toMatch(/camera=\(\)/);
    expect(v["Permissions-Policy"]).toMatch(/geolocation=\(\)/);
  });
  it("leaves the CSP out in development, where the dev server needs eval", () => {
    expect(names(buildSecurityHeaders({ production: false }))).not.toContain(
      "Content-Security-Policy",
    );
  });
});
