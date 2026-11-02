import { describe, expect, it } from "vitest";
import {
  expectedUpdatedAtSchema,
  expectedVersionSchema,
  StaleEditError,
  updateIfCurrent,
} from "./concurrency";
import { errorResponse } from "./envelope";
import { NotFoundError } from "./errors";

type Call = { op: string; args: unknown[] };

/** A recording stand-in for the Supabase query builder. `updateRow` / `currentRow` are what the two queries return. */
function fakeClient(updateRow: unknown, currentRow: unknown) {
  const calls: Call[] = [];
  const builder = (kind: "update" | "select") => {
    const b: Record<string, unknown> = {};
    for (const op of ["update", "select", "eq"]) {
      b[op] = (...args: unknown[]) => {
        calls.push({ op: `${kind}.${op}`, args });
        return b;
      };
    }
    b.maybeSingle = async () => ({
      data: kind === "update" ? updateRow : currentRow,
      error: null,
    });
    return b;
  };
  let first = true;
  return {
    calls,
    client: {
      from: () => {
        const kind = first ? "update" : "select";
        first = false;
        return kind === "update"
          ? { update: builder("update").update }
          : { select: builder("select").select };
      },
    } as never,
  };
}

describe("expected-version fields", () => {
  it("accepts what the API returned, with microseconds and any offset", () => {
    for (const ok of [
      "2026-11-02T01:54:54.995123+00:00",
      "2026-11-02T01:54:54Z",
      "2026-11-02T01:54:54.5-05:00",
    ]) {
      expect(expectedUpdatedAtSchema.safeParse(ok).success, ok).toBe(true);
    }
  });
  it("rejects anything else", () => {
    for (const bad of ["", "yesterday", "2026-11-02", "2026-11-02 01:54:54", 5, null]) {
      expect(expectedUpdatedAtSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
    expect(expectedVersionSchema.safeParse(0).success).toBe(false);
    expect(expectedVersionSchema.safeParse(1.5).success).toBe(false);
    expect(expectedVersionSchema.safeParse("2").success).toBe(false);
    expect(expectedVersionSchema.safeParse(3).success).toBe(true);
  });
});

describe("StaleEditError", () => {
  it("is a 409 with a stable code and the current version in error.meta", async () => {
    const res = errorResponse(
      new StaleEditError({ updatedAt: "2026-11-02T01:54:54.995123+00:00" }),
      "req-1",
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatchObject({
      code: "STALE_EDIT",
      requestId: "req-1",
      meta: { current: { updatedAt: "2026-11-02T01:54:54.995123+00:00" } },
    });
  });
});

describe("updateIfCurrent", () => {
  it("matches on id and the exact updated_at, and returns the updated row", async () => {
    const { client, calls } = fakeClient({ id: "1", name: "B" }, null);
    const row = await updateIfCurrent(client, {
      table: "customers",
      id: "1",
      expected: { updatedAt: "2026-11-02T01:54:54.995123+00:00" },
      patch: { name: "B" },
    });
    expect(row).toEqual({ id: "1", name: "B" });
    expect(calls.map((c) => c.op)).toEqual([
      "update.update",
      "update.eq",
      "update.eq",
      "update.select",
    ]);
    expect(calls[1].args).toEqual(["id", "1"]);
    expect(calls[2].args).toEqual(["updated_at", "2026-11-02T01:54:54.995123+00:00"]);
  });
  it("matches on version when the entity uses one", async () => {
    const { client, calls } = fakeClient({ id: "1" }, null);
    await updateIfCurrent(client, {
      table: "quotes",
      id: "1",
      expected: { version: 4 },
      patch: {},
    });
    expect(calls[2].args).toEqual(["version", 4]);
  });
  it("throws StaleEditError with the current value when the record exists but moved on", async () => {
    const { client } = fakeClient(null, { updated_at: "2026-11-02T02:00:00+00:00" });
    await expect(
      updateIfCurrent(client, {
        table: "customers",
        id: "1",
        expected: { updatedAt: "2026-11-02T01:00:00+00:00" },
        patch: {},
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "STALE_EDIT",
      current: { updatedAt: "2026-11-02T02:00:00+00:00" },
    });
  });
  it("reports the current version for version-based entities", async () => {
    const { client } = fakeClient(null, { updated_at: "t", version: 7 });
    await expect(
      updateIfCurrent(client, { table: "quotes", id: "1", expected: { version: 6 }, patch: {} }),
    ).rejects.toMatchObject({ current: { updatedAt: "t", version: 7 } });
  });
  it("throws NotFoundError when the caller cannot see the record (missing or another tenant's)", async () => {
    const { client } = fakeClient(null, null);
    await expect(
      updateIfCurrent(client, { table: "customers", id: "1", expected: { version: 1 }, patch: {} }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
