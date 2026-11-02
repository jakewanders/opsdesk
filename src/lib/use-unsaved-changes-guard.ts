"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

/**
 * Stops a person from losing edits by accident. While `active`:
 * - closing or reloading the tab asks the browser to confirm;
 * - clicking any link to another page of the app is held back and `pendingHref` is set, so the screen can show a
 *   "Discard changes?" dialog. `confirmLeave` then goes there; `stay` dismisses the question.
 * Browser Back/Forward is not intercepted (the App Router gives no hook for it); the tab-close prompt still applies.
 */
export function useUnsavedChangesGuard(active: boolean) {
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("/") || href.startsWith("//") || anchor.getAttribute("target")) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingHref(href);
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [active]);

  const stay = useCallback(() => setPendingHref(null), []);
  const confirmLeave = useCallback(() => {
    const href = pendingHref;
    setPendingHref(null);
    if (href) router.push(href);
  }, [pendingHref, router]);

  return { pendingHref, stay, confirmLeave };
}
