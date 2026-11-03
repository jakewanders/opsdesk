/**
 * "Back to the list the way I left it". A list page remembers its own URL (path and filters) for the browser tab; a detail page's
 * breadcrumb and back link read it, so going to a record and back keeps the search, filters, sort and page. Stored per tab
 * (sessionStorage), never sent anywhere, and only ever a same-site path under the list's own route: anything else is ignored, so a
 * tampered value cannot turn a back link into a redirect.
 */
export const LIST_ROUTES = {
  customers: "/app/customers",
  opportunities: "/app/opportunities",
  tasks: "/app/tasks",
  quotes: "/app/quotes",
  activity: "/app/activity",
  reports: "/app/reports",
} as const;
export type ListKey = keyof typeof LIST_ROUTES;

const KEY = (list: ListKey) => `opsdesk:list:${list}`;

/** The remembered URL if it is a path of this list's route (optionally with a query), else null. */
export function safeListUrl(list: ListKey, value: unknown): string | null {
  if (typeof value !== "string" || value.length > 600) return null;
  const route = LIST_ROUTES[list];
  if (value === route) return value;
  if (!value.startsWith(`${route}?`)) return null;
  // no scheme, backslash, control character or second path hidden in the query part
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f]/.test(value) || value.includes("//")) return null;
  return value;
}

export function rememberList(list: ListKey, url: string): void {
  try {
    const safe = safeListUrl(list, url);
    if (safe) window.sessionStorage.setItem(KEY(list), safe);
  } catch {
    /* storage can be blocked: the back link then points at the plain list */
  }
}

export function recallList(list: ListKey): string {
  try {
    return safeListUrl(list, window.sessionStorage.getItem(KEY(list))) ?? LIST_ROUTES[list];
  } catch {
    return LIST_ROUTES[list];
  }
}
