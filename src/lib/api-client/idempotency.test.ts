import { describe, expect, it } from "vitest";
import { createSingleFlight, newIdempotencyKey } from "./idempotency";

describe("newIdempotencyKey", () => {
  it("makes distinct keys the server accepts", () => {
    const a = newIdempotencyKey();
    expect(a).not.toBe(newIdempotencyKey());
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });
});

describe("createSingleFlight", () => {
  it("ignores a second submit while the first is pending, and sends once", async () => {
    const flight = createSingleFlight<string>(() => "key-1");
    let sent = 0;
    let finish!: (v: string) => void;
    const send = () => new Promise<string>((r) => ((sent += 1), (finish = r)));
    const a = flight.run(send);
    const b = flight.run(send);
    expect(flight.pending).toBe(true);
    expect(b).toBe(a);
    finish("done");
    expect(await a).toBe("done");
    expect(sent).toBe(1);
    expect(flight.pending).toBe(false);
  });
  it("reuses the same key when an attempt fails, and makes a new one after success", async () => {
    let n = 0;
    const flight = createSingleFlight<string>(() => `key-${++n}`);
    const seen: string[] = [];
    await expect(
      flight.run(async (k) => {
        seen.push(k);
        throw new Error("network");
      }),
    ).rejects.toThrow("network");
    expect(flight.key).toBe("key-1");
    await flight.run(async (k) => (seen.push(k), "ok"));
    expect(flight.key).toBeNull();
    await flight.run(async (k) => (seen.push(k), "ok"));
    expect(seen).toEqual(["key-1", "key-1", "key-2"]);
  });
});
