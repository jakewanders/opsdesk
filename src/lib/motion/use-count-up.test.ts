import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCountUp } from "./use-count-up";

function stubMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("useCountUp", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns the target at once under reduced motion", () => {
    stubMotion(true);
    expect(renderHook(() => useCountUp(15)).result.current).toBe(15);
  });

  it("counts from 0 to the target on first mount", () => {
    stubMotion(false);
    const { result } = renderHook(() => useCountUp(15));
    expect(result.current).toBe(0);
    advance(300);
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThan(15);
    advance(400);
    expect(result.current).toBe(15);
  });

  it("keeps the target when reduced motion is switched off after mount", () => {
    let reduce = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return reduce;
      },
      media: query,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    }));
    const { result } = renderHook(() => useCountUp(15));
    expect(result.current).toBe(15);
    reduce = false;
    act(() => listeners.forEach((l) => l()));
    advance(800);
    expect(result.current).toBe(15);
  });

  it("starts at the target when told not to count from zero", () => {
    stubMotion(false);
    expect(renderHook(() => useCountUp(15, { fromZero: false })).result.current).toBe(15);
  });

  it("tweens to a new target without ever producing NaN", () => {
    stubMotion(false);
    const { result, rerender } = renderHook(({ n }) => useCountUp(n, { fromZero: false }), {
      initialProps: { n: 10 },
    });
    rerender({ n: 20 });
    advance(100);
    expect(Number.isNaN(result.current)).toBe(false);
    expect(result.current).toBeGreaterThan(10);
    expect(result.current).toBeLessThan(20);
    advance(300);
    expect(result.current).toBe(20);
  });

  it("returns 0 for a target that is not a finite number", () => {
    stubMotion(false);
    expect(renderHook(() => useCountUp(Number.NaN)).result.current).toBe(0);
  });
});
