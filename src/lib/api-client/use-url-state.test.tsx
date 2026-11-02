import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebouncedUrlParam, useDebouncedValue, useUrlState } from "./use-url-state";
import { defineUrlState, urlField } from "./url-state";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  search: "",
  path: "/app/customers",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const schema = defineUrlState({
  q: urlField.string(),
  page: urlField.int(1, 1, 500),
  stage: urlField.list(["lead", "won"]),
});

beforeEach(() => {
  nav.push.mockClear();
  nav.replace.mockClear();
  nav.search = "";
});

describe("useUrlState", () => {
  it("restores the state from the URL on load", () => {
    nav.search = "q=acme&page=3&stage=won";
    const { result } = renderHook(() => useUrlState(schema));
    expect(result.current[0]).toEqual({ q: "acme", page: 3, stage: ["won"] });
  });
  it("a filter change replaces the URL (no history spam) and returns to page 1", () => {
    nav.search = "page=3";
    const { result } = renderHook(() => useUrlState(schema));
    act(() => result.current[1]({ stage: ["lead"] }));
    expect(nav.replace).toHaveBeenCalledWith("/app/customers?stage=lead", { scroll: false });
    expect(nav.push).not.toHaveBeenCalled();
  });
  it("a page change pushes a history entry and keeps the filters", () => {
    nav.search = "q=acme";
    const { result } = renderHook(() => useUrlState(schema));
    act(() => result.current[1]({ page: 2 }));
    expect(nav.push).toHaveBeenCalledWith("/app/customers?q=acme&page=2", { scroll: false });
  });
  it("clearing everything gives the bare path", () => {
    nav.search = "q=acme";
    const { result } = renderHook(() => useUrlState(schema));
    act(() => result.current[1]({ q: "" }));
    expect(nav.replace).toHaveBeenCalledWith("/app/customers", { scroll: false });
  });
  it("garbage in the URL yields defaults, never an exception", () => {
    nav.search = "page=%E0%A4%A&stage=;;&q=%00";
    const { result } = renderHook(() => useUrlState(schema));
    expect(result.current[0].page).toBe(1);
    expect(result.current[0].stage).toEqual([]);
  });
});

describe("debouncing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("useDebouncedValue follows the value only after it stops changing", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), {
      initialProps: { v: "a" },
    });
    rerender({ v: "ab" });
    rerender({ v: "abc" });
    act(() => void vi.advanceTimersByTime(299));
    expect(result.current).toBe("a");
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe("abc");
  });

  it("a search box updates the input at once and the URL once, after the pause", () => {
    const commit = vi.fn();
    const { result } = renderHook(() => useDebouncedUrlParam("", commit, 300));
    act(() => result.current[1]("a"));
    act(() => result.current[1]("ac"));
    act(() => result.current[1]("acm "));
    expect(result.current[0]).toBe("acm ");
    expect(commit).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(300));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith("acm");
  });

  it("a URL change from outside (Back, a link) replaces the input text", () => {
    const { result, rerender } = renderHook(({ url }) => useDebouncedUrlParam(url, vi.fn(), 300), {
      initialProps: { url: "x" },
    });
    expect(result.current[0]).toBe("x");
    rerender({ url: "back-button" });
    expect(result.current[0]).toBe("back-button");
  });

  it("does not commit after unmount", () => {
    const commit = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedUrlParam("", commit, 300));
    act(() => result.current[1]("a"));
    unmount();
    act(() => void vi.advanceTimersByTime(1000));
    expect(commit).not.toHaveBeenCalled();
  });
});
