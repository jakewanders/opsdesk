import { describe, expect, it } from "vitest";
import { okItem } from "./envelope";
import { hashRequest, readIdempotencyKey, withIdempotency } from "./idempotency";

const req = (key?: string) =>
  new Request("http://x.test/", {
    method: "POST",
    headers: key === undefined ? {} : { "Idempotency-Key": key },
  });

describe("readIdempotencyKey", () => {
  it("is null when absent and the trimmed key when valid", () => {
    expect(readIdempotencyKey(req())).toBeNull();
    expect(readIdempotencyKey(req(" abcd1234-efgh "))).toBe("abcd1234-efgh");
  });
  it("refuses a malformed key with IDEMPOTENCY_KEY_INVALID instead of ignoring it", () => {
    for (const bad of [
      "",
      "short",
      "has spaces in it",
      "a".repeat(129),
      "bad/char/xx",
      "ünïcode-key-1",
    ]) {
      expect(() => readIdempotencyKey(req(bad)), bad).toThrowError(
        expect.objectContaining({ status: 422, code: "IDEMPOTENCY_KEY_INVALID" }),
      );
    }
  });
});

describe("hashRequest", () => {
  it("ignores key order and undefined fields, but not values", () => {
    expect(hashRequest({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(
      hashRequest({ b: { d: [1, 2], c: 2 }, a: 1, z: undefined }),
    );
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
    expect(hashRequest([1, 2])).not.toBe(hashRequest([2, 1]));
    expect(hashRequest(undefined)).toBe(hashRequest(null));
  });
});

/** An in-memory stand-in for the three database functions, with their documented states. */
function fakeStore() {
  const rows = new Map<string, { hash: string; done?: { status: number; body: unknown } }>();
  const log: string[] = [];
  return {
    log,
    rows,
    client: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        const id = `${args.p_route}|${args.p_key}`;
        log.push(fn);
        if (fn === "idempotency_begin") {
          const row = rows.get(id);
          if (!row) {
            rows.set(id, { hash: String(args.p_hash) });
            return { data: { state: "new" }, error: null };
          }
          if (row.hash !== args.p_hash) return { data: { state: "mismatch" }, error: null };
          if (row.done) return { data: { state: "replay", ...row.done }, error: null };
          return { data: { state: "in_progress" }, error: null };
        }
        if (fn === "idempotency_complete") {
          rows.get(id)!.done = { status: args.p_status as number, body: args.p_body };
          return { data: true, error: null };
        }
        rows.delete(id);
        return { data: true, error: null };
      },
    } as never,
  };
}

describe("withIdempotency", () => {
  const opts = { route: "POST /x", key: "key-12345678", payload: { a: 1 } };

  it("runs the work once and replays the stored result for the same key and payload", async () => {
    const { client } = fakeStore();
    let runs = 0;
    const work = async () => (runs++, okItem({ id: "created" }));
    const first = await withIdempotency(client, opts, work);
    const second = await withIdempotency(client, opts, work);
    expect(runs).toBe(1);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
  });
  it("without a key it just runs the work, every time, and never touches the store", async () => {
    const { client, log } = fakeStore();
    let runs = 0;
    await withIdempotency(client, { ...opts, key: null }, async () => (runs++, okItem({})));
    await withIdempotency(client, { ...opts, key: null }, async () => (runs++, okItem({})));
    expect(runs).toBe(2);
    expect(log).toEqual([]);
  });
  it("refuses the same key with a different payload and does not run the work", async () => {
    const { client } = fakeStore();
    await withIdempotency(client, opts, async () => okItem({}));
    let ran = false;
    await expect(
      withIdempotency(
        client,
        { ...opts, payload: { a: 2 } },
        async () => ((ran = true), okItem({})),
      ),
    ).rejects.toMatchObject({ status: 422, code: "IDEMPOTENCY_KEY_REUSED" });
    expect(ran).toBe(false);
  });
  it("tells a concurrent duplicate to wait (409 with Retry-After) and does not run the work", async () => {
    const { client } = fakeStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = withIdempotency(client, opts, async () => (await gate, okItem({})));
    await Promise.resolve();
    let ran = false;
    await expect(
      withIdempotency(client, opts, async () => ((ran = true), okItem({}))),
    ).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_IN_PROGRESS",
      headers: { "Retry-After": "2" },
    });
    release();
    await slow;
    expect(ran).toBe(false);
  });
  it("releases the key when the work fails, so the same key can be retried", async () => {
    const { client } = fakeStore();
    await expect(
      withIdempotency(client, opts, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    let runs = 0;
    await withIdempotency(client, opts, async () => (runs++, okItem({})));
    expect(runs).toBe(1);
  });
});
