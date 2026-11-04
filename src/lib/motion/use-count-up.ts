"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

const FIRST_MS = 600;
const CHANGE_MS = 280;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

type Options = {
  /** Count up from 0 on first mount (default). Pass false when the number was already on screen, such as server-rendered. */
  fromZero?: boolean;
};

/**
 * The number to show for `target`: it counts up once on first mount (up to 600ms) and tweens (280ms) when the target
 * changes. Under reduced motion, and for a target that is not a finite number, there is no animation.
 */
export function useCountUp(target: number, { fromZero = true }: Options = {}): number {
  const reduced = usePrefersReducedMotion();
  const finite = Number.isFinite(target);
  const safe = finite ? target : 0;
  const [value, setValue] = useState(fromZero ? 0 : safe);
  const shown = useRef(value);
  const first = useRef(true);

  useEffect(() => {
    if (reduced || !finite) {
      shown.current = safe;
      return;
    }
    const from = shown.current;
    const duration = first.current ? FIRST_MS : CHANGE_MS;
    first.current = false;
    if (from === safe) return;
    let frame = 0;
    let begin: number | null = null;
    const tick = (now: number) => {
      begin ??= now;
      const t = Math.min(1, (now - begin) / duration);
      shown.current = from + (safe - from) * easeOut(t);
      setValue(shown.current);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [safe, reduced, finite]);

  return reduced || !finite ? safe : value;
}
