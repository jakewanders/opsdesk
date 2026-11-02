"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyUrlChange,
  parseUrlState,
  serializeUrlState,
  type UrlSchema,
  type UrlState,
} from "./url-state";

/**
 * List state in the URL: reloading or sharing a link restores the same search, filters, sort and page. Changing
 * anything but the page returns to page 1. Filter changes replace the history entry, so Back does not step through
 * every keystroke; page changes push one.
 */
export function useUrlState<S extends UrlSchema>(schema: S) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const state = useMemo(() => parseUrlState(schema, params), [schema, params]);

  const set = useCallback(
    (change: Partial<UrlState<S>>) => {
      const next = applyUrlChange(schema, state, change);
      const qs = serializeUrlState(schema, next);
      const url = qs ? `${pathname}?${qs}` : pathname;
      const pageOnly = Object.keys(change).every((k) => k === "page");
      if (pageOnly) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [schema, state, pathname, router],
  );

  return [state, set] as const;
}

/** A value that follows `value` after it has stopped changing for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/**
 * A search box bound to a URL parameter: typing updates the input at once and the URL after `delayMs` without a
 * keystroke. A URL change from outside (Back, a link) replaces the input text.
 */
export function useDebouncedUrlParam(
  urlValue: string,
  commit: (value: string) => void,
  delayMs = 300,
) {
  const [input, setInput] = useState(urlValue);
  const [seen, setSeen] = useState(urlValue);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  if (urlValue !== seen) {
    setSeen(urlValue); // the URL moved on its own: follow it
    setInput(urlValue);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  const onChange = useCallback(
    (value: string) => {
      setInput(value);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => commit(value.trim()), delayMs);
    },
    [commit, delayMs],
  );
  return [input, onChange] as const;
}
