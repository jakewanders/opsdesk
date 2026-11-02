import { describe, expect, it, vi } from "vitest";
import { checkDatabase, checkHealth } from "./check";

const deps = (fetchImpl: typeof fetch, timeoutMs = 2500) => ({
  supabaseUrl: "http://127.0.0.1:54321/",
  publishableKey: "sb_publishable_test",
  timeoutMs,
  fetch: fetchImpl,
});
const reply = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("checkDatabase", () => {
  it("is ok when the probe answers true, and calls the no-data function with the publishable key only", async () => {
    const spy = vi.fn(reply(true));
    expect(await checkDatabase(deps(spy as unknown as typeof fetch))).toBe("ok");
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:54321/rest/v1/rpc/health_ping");
    expect(init.method).toBe("POST");
    expect(JSON.stringify(init.headers)).not.toMatch(/secret/i);
  });
  it.each([
    ["a 5xx", reply({ message: "boom" }, 503)],
    ["a 401", reply({ message: "bad key" }, 401)],
    ["a body that is not true", reply({ ok: true })],
    ["false", reply(false)],
    [
      "a non-JSON body",
      (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch,
    ],
    [
      "a refused connection",
      (async () => {
        throw new TypeError("fetch failed ECONNREFUSED");
      }) as unknown as typeof fetch,
    ],
  ])("is unavailable for %s", async (_n, impl) => {
    expect(await checkDatabase(deps(impl))).toBe("unavailable");
  });
  it("is unavailable when the database hangs: the timeout cuts it off", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) =>
        init.signal?.addEventListener("abort", () => reject(new DOMException("t", "TimeoutError"))),
      )) as unknown as typeof fetch;
    const started = Date.now();
    expect(await checkDatabase(deps(hang, 50))).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("is unavailable when the URL or key is not configured", async () => {
    expect(await checkDatabase({ supabaseUrl: undefined, publishableKey: "k" })).toBe(
      "unavailable",
    );
    expect(await checkDatabase({ supabaseUrl: "http://x", publishableKey: undefined })).toBe(
      "unavailable",
    );
  });
});

describe("checkHealth", () => {
  it("separates web from database and exposes nothing else", async () => {
    const down = await checkHealth(
      deps((async () => {
        throw new Error("secret host db.internal:5432 password=hunter2");
      }) as unknown as typeof fetch),
    );
    expect(down).toEqual({ web: "ok", database: "unavailable" });
    expect(JSON.stringify(down)).not.toMatch(/internal|hunter2|5432/);
    expect(await checkHealth(deps(reply(true)))).toEqual({ web: "ok", database: "ok" });
  });
});
