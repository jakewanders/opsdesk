import { describe, expect, it } from "vitest";
import { guardStaleAction, isStaleActionError, STALE_ACTION_MESSAGE } from "./stale-action";

const stale = () => {
  const e = new Error('Server Action "600556b66f279f80f0" was not found on the server.');
  e.name = "UnrecognizedActionError";
  return e;
};
const state = { status: "idle", attempt: 2 };

describe("isStaleActionError", () => {
  it("recognizes Next.js's error by name and by message", () => {
    expect(isStaleActionError(stale())).toBe(true);
    expect(isStaleActionError(new Error("Failed to find Server Action abc"))).toBe(true);
  });
  it("does not mistake other errors for it", () => {
    expect(isStaleActionError(new Error("network down"))).toBe(false);
    expect(isStaleActionError("UnrecognizedActionError")).toBe(false);
    expect(isStaleActionError(null)).toBe(false);
  });
});

describe("guardStaleAction", () => {
  it("passes a normal result through", async () => {
    const guarded = guardStaleAction(async (s: typeof state) => ({ ...s, status: "ok" }));
    expect(await guarded(state, new FormData())).toEqual({ status: "ok", attempt: 2 });
  });
  it("turns a stale-page error into a form error that says to reload, and counts the attempt", async () => {
    const guarded = guardStaleAction(async (): Promise<typeof state> => {
      throw stale();
    });
    expect(await guarded(state, new FormData())).toMatchObject({
      status: "error",
      attempt: 3,
      message: STALE_ACTION_MESSAGE,
    });
    expect(STALE_ACTION_MESSAGE).toMatch(/reload/i);
    expect(STALE_ACTION_MESSAGE).toMatch(/nothing was saved/i);
  });
  it("rethrows every other error for the error boundary", async () => {
    const boom = new Error("boom");
    const guarded = guardStaleAction(async (): Promise<typeof state> => {
      throw boom;
    });
    await expect(guarded(state, new FormData())).rejects.toBe(boom);
  });
});
