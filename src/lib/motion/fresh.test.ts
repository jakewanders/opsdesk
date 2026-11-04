import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFresh, clearFreshForTests, markFresh, useIsFresh } from "./fresh";

describe("fresh-id store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    clearFreshForTests();
    vi.useRealTimers();
  });

  it("marks only the given id as fresh", () => {
    const a = renderHook(() => useIsFresh("a"));
    const b = renderHook(() => useIsFresh("b"));
    act(() => markFresh("a"));
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(false);
  });

  it("can be cleared at once, for a change that was refused", () => {
    const a = renderHook(() => useIsFresh("a"));
    act(() => markFresh("a"));
    act(() => clearFresh("a"));
    expect(a.result.current).toBe(false);
  });

  it("stops being fresh after 1600ms", () => {
    const a = renderHook(() => useIsFresh("a"));
    act(() => markFresh("a"));
    act(() => void vi.advanceTimersByTime(1600));
    expect(a.result.current).toBe(false);
  });

  it("can stay fresh longer, for a row the person will come back to", () => {
    const a = renderHook(() => useIsFresh("a"));
    act(() => markFresh("a", 30_000));
    act(() => void vi.advanceTimersByTime(29_999));
    expect(a.result.current).toBe(true);
    act(() => void vi.advanceTimersByTime(1));
    expect(a.result.current).toBe(false);
  });

  it("restarts the timer when marked again", () => {
    const a = renderHook(() => useIsFresh("a"));
    act(() => markFresh("a"));
    act(() => void vi.advanceTimersByTime(1000));
    act(() => markFresh("a"));
    act(() => void vi.advanceTimersByTime(1000));
    expect(a.result.current).toBe(true);
    act(() => void vi.advanceTimersByTime(600));
    expect(a.result.current).toBe(false);
  });
});
