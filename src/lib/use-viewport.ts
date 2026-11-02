"use client";

import { useSyncExternalStore } from "react";

const WIDE = "(min-width: 768px)";

/**
 * `"desktop"` at 768px and wider, `"mobile"` below, and `"pending"` until the browser has been asked (on the server and
 * during hydration), so a screen that depends on the width can wait instead of rendering the wrong thing first.
 */
export function useViewport(): "pending" | "desktop" | "mobile" {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(WIDE);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => (window.matchMedia(WIDE).matches ? "desktop" : "mobile"),
    () => "pending",
  );
}
