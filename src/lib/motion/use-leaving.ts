"use client";

import { useRef, useState } from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

/** How long a row takes to leave before its change is sent. Matches --motion-base. */
const LEAVE_MS = 180;

/**
 * An item the person just acted on (a completed task) leaves first, then the change is sent. `isLeaving(id)` drives the exit
 * styling; `start(item)` begins it. Under reduced motion the change is sent at once. Starting an item that is already leaving or
 * still being sent does nothing, and when the send settles (even when it is refused) the item stops leaving, so a row that was
 * put back by a rollback comes back fully visible. The caller reports failures; this hook swallows them.
 */
export function useLeaving<T extends { id: string }>(send: (item: T) => Promise<unknown>) {
  const reduced = usePrefersReducedMotion();
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const started = useRef(new Set<string>());

  const setLeave = (id: string, on: boolean) =>
    setLeaving((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const start = (item: T) => {
    if (started.current.has(item.id)) return;
    started.current.add(item.id);
    const go = () =>
      void Promise.resolve(send(item))
        .catch(() => undefined)
        .finally(() => {
          started.current.delete(item.id);
          setLeave(item.id, false);
        });
    if (reduced) return go();
    setLeave(item.id, true);
    setTimeout(go, LEAVE_MS);
  };

  return { isLeaving: (id: string) => leaving.has(id), start };
}
