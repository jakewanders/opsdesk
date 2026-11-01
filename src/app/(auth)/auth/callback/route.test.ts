import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const exchange = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession: exchange } }),
}));

const APP = "https://opsdesk.sitelaunch.dev";
const call = async (query: string, headers: Record<string, string> = {}) => {
  const { GET } = await import("./route");
  return GET(new NextRequest(`https://anything.example/auth/callback${query}`, { headers }));
};
const location = (r: Response) => r.headers.get("location");

beforeEach(() => {
  exchange.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  process.env.NEXT_PUBLIC_APP_URL = APP;
});

describe("GET /auth/callback", () => {
  it("exchanges the code and sends the visitor to /app by default", async () => {
    exchange.mockResolvedValue({ error: null });
    const res = await call("?code=abc");
    expect(exchange).toHaveBeenCalledWith("abc");
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${APP}/app`);
  });
  it("sends a recovery link on to /reset-password", async () => {
    exchange.mockResolvedValue({ error: null });
    expect(location(await call("?code=abc&next=/reset-password"))).toBe(`${APP}/reset-password`);
  });
  it("honours an in-app next", async () => {
    exchange.mockResolvedValue({ error: null });
    expect(location(await call("?code=abc&next=/app/customers%3Fpage%3D2"))).toBe(
      `${APP}/app/customers?page=2`,
    );
  });
  it("never leaves the trusted origin, whatever next or the Host header say", async () => {
    exchange.mockResolvedValue({ error: null });
    for (const next of [
      "//evil.com",
      "https://evil.com",
      "/\\evil.com",
      "%2F%2Fevil.com",
      "javascript:alert(1)",
      "/login",
      "/reset-password/x",
    ]) {
      const res = await call(`?code=abc&next=${next}`, {
        host: "evil.com",
        "x-forwarded-host": "evil.com",
      });
      expect(location(res), next).toBe(`${APP}/app`);
    }
  });
  it("an invalid or reused code goes to the login page with a notice, not an error page", async () => {
    exchange.mockResolvedValue({ error: { message: "invalid flow state", status: 400 } });
    const res = await call("?code=used");
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`${APP}/login?error=callback`);
  });
  it("a missing code, an empty code and a thrown error all fail the same friendly way", async () => {
    expect(location(await call(""))).toBe(`${APP}/login?error=callback`);
    expect(location(await call("?code="))).toBe(`${APP}/login?error=callback`);
    exchange.mockRejectedValue(new Error("network down"));
    expect(location(await call("?code=abc"))).toBe(`${APP}/login?error=callback`);
  });
  it("does not leak the failure in the response body", async () => {
    exchange.mockResolvedValue({ error: { message: "secret internal detail" } });
    const res = await call("?code=bad");
    expect(await res.text()).not.toContain("secret internal detail");
  });
});
