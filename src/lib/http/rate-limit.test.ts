import { describe, expect, it } from "vitest";
import { clientKey, createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  it("allows the budget, then refuses until the window ends, with a retry hint", () => {
    let t = 1_000;
    const rl = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => t });
    expect([1, 2, 3].map(() => rl.hit("a").allowed)).toEqual([true, true, true]);
    const blocked = rl.hit("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
    t += 60_000;
    expect(rl.hit("a").allowed).toBe(true);
  });
  it("counts each caller separately", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.hit("a").allowed).toBe(true);
    expect(rl.hit("b").allowed).toBe(true);
    expect(rl.hit("a").allowed).toBe(false);
  });
  it("stays bounded under many distinct callers", () => {
    const rl = createRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 100 });
    for (let i = 0; i < 10_000; i++) rl.hit(`ip-${i}`);
    expect(rl.hit("ip-new").allowed).toBe(true);
  });
});

describe("clientKey", () => {
  it("prefers the platform's connection address, then the first forwarded one", () => {
    expect(
      clientKey(
        new Headers({ "x-nf-client-connection-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }),
      ),
    ).toBe("1.1.1.1");
    expect(clientKey(new Headers({ "x-forwarded-for": "2.2.2.2, 3.3.3.3" }))).toBe("2.2.2.2");
    expect(clientKey(new Headers())).toBe("unknown");
  });
});
