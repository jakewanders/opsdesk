/**
 * A log-safe label for a request path: ids become `:id`, so customer UUIDs never spread through the logs and the same
 * route groups together. The query string is never part of it.
 */
export function routeLabel(pathname: string): string {
  return pathname
    .split("?")[0]
    .split("/")
    .map((segment) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
      /^\d{4,}$/.test(segment)
        ? ":id"
        : segment.slice(0, 60),
    )
    .join("/")
    .slice(0, 200);
}
