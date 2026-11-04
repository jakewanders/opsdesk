import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFreshForTests, markFresh, useIsFresh } from "./fresh";

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

  it("stops being fresh after 1600ms", () => {
    const a = renderHook(() => useIsFresh("a"));
    act(() => markFresh("a"));
    act(() => void vi.advanceTimersByTime(1600));
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
