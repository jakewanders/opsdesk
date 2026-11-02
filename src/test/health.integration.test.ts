import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RealServer } from "@/test/real-server";

/** [SIT-186] /api/health, the landing page and /demo with the database up and with it unreachable. */
const up = new RealServer();
// A closed port stands in for a stopped or paused Supabase project: real connections, really refused.
const down = new RealServer({ supabaseUrl: "http://127.0.0.1:1" });

beforeAll(async () => {
  await Promise.all([up.start(), down.start()]);
}, 400_000);
afterAll(() => {
  up.stop();
  down.stop();
});

describe("/api/health with the database up", () => {
  it("reports web ok and database ok, uncached, with nothing else in the body", async () => {
    const res = await up.request("/api/health", null);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ web: "ok", database: "ok" });
  });
  it("needs no session and ignores a bogus cookie", async () => {
    const res = await fetch(`${up.base}/api/health`, {
      headers: { cookie: "sb-local-auth-token=garbage" },
    });
    expect(res.status).toBe(200);
  });
  it("is rate limited: the 31st call in a minute is 429 with Retry-After", async () => {
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 40; i++) {
      last = await fetch(`${up.base}/api/health`, {
        headers: { "x-forwarded-for": "203.0.113.77" },
      });
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(30).every((s) => s === 429)).toBe(true);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    // another caller is unaffected
    expect(
      (await fetch(`${up.base}/api/health`, { headers: { "x-forwarded-for": "203.0.113.78" } }))
        .status,
    ).toBe(200);
  });
});

describe("with the database unreachable", () => {
  it("/api/health reports database unavailable quickly, still web ok, and leaks nothing", async () => {
    const started = Date.now();
    const res = await down.request("/api/health", null);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ web: "ok", database: "unavailable" });
    expect(text).not.toMatch(/127\.0\.0\.1|ECONN|refused|fetch failed/i);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("the landing page and legal pages still render", async () => {
    for (const path of ["/", "/privacy", "/terms"]) {
      const res = await down.request(path, null);
      expect(res.status, path).toBe(200);
    }
    expect(await (await down.request("/", null)).text()).toContain("OpsDesk");
  });

  it("/demo renders the entry flow (it is the browser's sign-in that then fails and offers retry and links)", async () => {
    const res = await down.request("/demo", null);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Opening your demo");
  });

  it("/app does not render a workspace shell for a visitor: it goes to sign-in", async () => {
    const res = await down.request("/app", null);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });
});
