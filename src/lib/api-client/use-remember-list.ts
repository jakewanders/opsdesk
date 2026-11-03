"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { LIST_ROUTES, recallList, rememberList, type ListKey } from "./list-memory";

/** Call in a list page: its current URL is remembered for the detail pages' back links. */
export function useRememberList(list: ListKey): void {
  const pathname = usePathname();
  const params = useSearchParams();
  const qs = params.toString();
  useEffect(() => {
    if (pathname === LIST_ROUTES[list]) rememberList(list, qs ? `${pathname}?${qs}` : pathname);
  }, [list, pathname, qs]);
}

/** The URL to go back to: the list as it was left. Renders the plain list on the server and first paint, then the remembered one. */
export function useListBackUrl(list: ListKey): string {
  return useSyncExternalStore(
    () => () => undefined,
    () => recallList(list),
    () => LIST_ROUTES[list],
  );
}
