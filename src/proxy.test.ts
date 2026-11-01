import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTES } from "@/lib/routes";

// The session refresh talks to Supabase; routing and headers are what is under test here.
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; isAnonymous: boolean },
}));
vi.mock("@/lib/supabase/middleware", async () => {
  const real = await vi.importActual<typeof import("@/lib/supabase/middleware")>(
    "@/lib/supabase/middleware",
  );
  return {
    ...real,
    updateSession: async () => ({ response: NextResponse.next(), user: state.user, supabase: {} }),
  };
});
vi.mock("@/lib/auth/workspace-state", () => ({ resolveWorkspaceState: async () => "ready" }));

import { proxy } from "./proxy";

const call = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  proxy(new NextRequest(`http://localhost:3000${path}`, init));

/** Every path whose response can depend on a session. */
const PRIVATE_PATHS = [
  ...ROUTES.filter(
    (r) =>
      r.group === "app" ||
      [
        "/demo",
        "/login",
        "/signup",
        "/forgot-password",
        "/reset-password",
        "/auth/callback",
      ].includes(r.path),
  ).map((r) => r.sample ?? r.path),
  "/app/setup",
  "/api/v1/session",
  "/api/v1/customers?page=2",
  "/api/v1/organizations/abc",
  "/api/health",
];
const PUBLIC_PATHS = ["/", "/privacy", "/terms"];

const isPrivateNoStore = (res: Response) => {
  const cc = res.headers.get("cache-control") ?? "";
  return /\bprivate\b/i.test(cc) && /\bno-store\b/i.test(cc);
};

beforeEach(() => {
  state.user = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "k";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_ENABLE_BILLING = "false";
  process.env.NEXT_PUBLIC_ENABLE_INTEGRATIONS = "false";
});

describe("private cache policy on every protected route", () => {
  it("covers a meaningful set of paths", () => {
    expect(PRIVATE_PATHS.length).toBeGreaterThan(25);
  });
  for (const who of ["signed out", "member", "guest"] as const) {
    it(`sends private, no-store for ${who}, including redirects`, async () => {
      state.user =
        who === "signed out"
          ? null
          : { id: "u", email: "u@example.com", isAnonymous: who === "guest" };
      for (const path of PRIVATE_PATHS) {
        const res = await call(path);
        expect(
          isPrivateNoStore(res),
          `${who} ${path} -> ${res.status} cache-control="${res.headers.get("cache-control")}"`,
        ).toBe(true);
        expect(res.headers.get("vary") ?? "", path).toMatch(/cookie/i);
      }
    });
  }
  it("also covers non-GET API calls and flag-disabled routes", async () => {
    expect(isPrivateNoStore(await call("/api/v1/customers", { method: "POST" }))).toBe(true);
    expect(isPrivateNoStore(await call("/app/settings/billing"))).toBe(true);
    expect(isPrivateNoStore(await call("/app/settings/integrations"))).toBe(true);
  });
  it("never loosens a stricter policy that is already set", async () => {
    // simulate Next's own header on the response
    const { applyPrivateNoStore } = await import("@/lib/http/cache-control");
    const res = new Response(null, {
      headers: { "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate" },
    });
    applyPrivateNoStore(res);
    expect(res.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });
  it("overrides a cacheable policy on a private route", async () => {
    const { applyPrivateNoStore } = await import("@/lib/http/cache-control");
    const res = new Response(null, { headers: { "cache-control": "public, s-maxage=31536000" } });
    applyPrivateNoStore(res);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("public pages stay cacheable", () => {
  it("get no cache override and no session cookies", async () => {
    for (const path of PUBLIC_PATHS) {
      const res = await call(path);
      expect(res.headers.get("cache-control"), path).toBeNull();
      expect(res.headers.get("set-cookie"), path).toBeNull();
      expect(res.headers.get("vary") ?? "", path).not.toMatch(/cookie/i);
    }
  });
});

describe("settings index", () => {
  it("is a 307 to the organization settings, with the private cache policy", async () => {
    state.user = { id: "u", email: "u@example.com", isAnonymous: false };
    const res = await call("/app/settings");
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/app/settings/organization");
    expect(isPrivateNoStore(res)).toBe(true);
  });
  it("sends a signed-out visitor to login first, not to the settings page", async () => {
    state.user = null;
    const res = await call("/app/settings");
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/login");
  });
});
