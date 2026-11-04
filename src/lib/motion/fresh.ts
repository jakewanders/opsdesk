"use client";

import { useSyncExternalStore } from "react";

/** How long a just-changed row or card stays "fresh" (long enough for the flash and settle animations). */
const FRESH_MS = 1600;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Say "this entity just changed": lists and boards highlight it for a moment. Calling again restarts the timer. */
export function markFresh(id: string): void {
  const running = timers.get(id);
  if (running) clearTimeout(running);
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      emit();
    }, FRESH_MS),
  );
  emit();
}

export function useIsFresh(id: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => void listeners.delete(notify);
    },
    () => timers.has(id),
    () => false,
  );
}

export function clearFreshForTests(): void {
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
  emit();
}
