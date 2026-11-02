import { defineUrlState, urlField, type UrlState } from "@/lib/api-client/url-state";
import { isoDate } from "@/lib/validation";
import { ACTIVITY_ACTIONS, ACTIVITY_ENTITY_TYPES } from "./schema";

/** The activity page's state as it lives in the URL. Names match the API's query; defaults are left out. */
export const activityPageUrl = defineUrlState({
  entityType: urlField.enum(["", ...ACTIVITY_ENTITY_TYPES], ""),
  action: urlField.enum(["", ...ACTIVITY_ACTIONS], ""),
  actor: urlField.string("", 36),
  from: urlField.string("", 10),
  to: urlField.string("", 10),
  page: urlField.int(1, 1, 1_000_000),
  limit: urlField.int(25, 1, 100),
});
export type ActivityPageState = UrlState<typeof activityPageUrl>;

export const PAGE_SIZES = [10, 25, 50, 100] as const;

const validDate = (v: string): string | undefined =>
  isoDate().safeParse(v).success ? v : undefined;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The API query: empty or invalid values are left out (a bad date or id in the URL never reaches the API). */
export function toActivityQuery(s: ActivityPageState): Record<string, string | number | undefined> {
  const from = validDate(s.from);
  const to = validDate(s.to);
  return {
    page: s.page,
    limit: s.limit,
    entityType: s.entityType || undefined,
    action: s.action || undefined,
    actor: s.actor === "system" || UUID.test(s.actor) ? s.actor : undefined,
    from,
    // a reversed range would be a 422; keep the page working by dropping `to`
    to: from && to && from > to ? undefined : to,
  };
}

export function hasActiveFilters(s: ActivityPageState): boolean {
  const q = toActivityQuery(s);
  return Boolean(q.entityType || q.action || q.actor || q.from || q.to);
}
