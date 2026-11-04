import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLeaving } from "./use-leaving";

function stubMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}
const item = { id: "t1" };

describe("useLeaving", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("marks the item as leaving, then sends once the exit has run", async () => {
    stubMotion(false);
    const send = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useLeaving(send));
    act(() => result.current.start(item));
    expect(result.current.isLeaving("t1")).toBe(true);
    expect(send).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(180));
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.isLeaving("t1")).toBe(false);
  });

  it("sends at once, with no exit, under reduced motion", () => {
    stubMotion(true);
    const send = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useLeaving(send));
    act(() => result.current.start(item));
    expect(result.current.isLeaving("t1")).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends once however often the same item is started", async () => {
    stubMotion(false);
    const send = vi.fn(() => new Promise<void>(() => {}));
    const { result } = renderHook(() => useLeaving(send));
    act(() => {
      result.current.start(item);
      result.current.start(item);
    });
    await act(async () => void vi.advanceTimersByTime(500));
    act(() => result.current.start(item));
    await act(async () => void vi.advanceTimersByTime(500));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stops leaving when the send is refused, so the row comes back", async () => {
    stubMotion(false);
    const send = vi.fn(() => Promise.reject(new Error("no")));
    const { result } = renderHook(() => useLeaving(send));
    act(() => result.current.start(item));
    await act(async () => void vi.advanceTimersByTime(200));
    expect(result.current.isLeaving("t1")).toBe(false);
  });
});
