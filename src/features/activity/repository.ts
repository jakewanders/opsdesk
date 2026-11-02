import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type Client = SupabaseClient<Database>;

export type ActivityEntity = "customer" | "opportunity" | "task" | "quote";

/** One change to a plain field, as the logging trigger recorded it (short scalar values only). */
export type FieldChange = { field: string; old: unknown; new: unknown };

export type ActivityEventDto = {
  id: string;
  action: string;
  summary: string;
  /** Null for the System (seeded data, automatic jobs). */
  actorUserId: string | null;
  createdAt: string;
  /** Plain fields with old and new values. */
  changes: FieldChange[];
  /** Free-text fields that changed: only their NAMES are ever stored. */
  contentChanged: string[];
};

type Row = {
  id: string;
  action: string;
  summary: string;
  actor_user_id: string | null;
  created_at: string;
  changes: unknown;
};

export function readChanges(raw: unknown): { changes: FieldChange[]; contentChanged: string[] } {
  if (typeof raw !== "object" || raw === null) return { changes: [], contentChanged: [] };
  const entries = Object.entries(raw as Record<string, unknown>);
  const content = (raw as Record<string, unknown>)._content_changed;
  return {
    contentChanged: Array.isArray(content)
      ? content.filter((c): c is string => typeof c === "string")
      : [],
    changes: entries
      .filter(
        ([key, value]) => key !== "_content_changed" && typeof value === "object" && value !== null,
      )
      .map(([field, value]) => ({
        field,
        old: (value as Record<string, unknown>).old,
        new: (value as Record<string, unknown>).new,
      })),
  };
}

/**
 * The newest events for one record of the caller's organization, read with the caller's own session (row level security
 * lets members read their workspace's events and nobody else's; the organization filter is a second line of defence).
 */
export async function listEntityActivity(
  supabase: Client,
  orgId: string,
  entityType: ActivityEntity,
  entityId: string,
  limit = 50,
): Promise<ActivityEventDto[]> {
  const { data, error } = await supabase
    .from("activity_events")
    .select("id, action, summary, actor_user_id, created_at, changes")
    .eq("organization_id", orgId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Row[]).map((row) => ({
    id: row.id,
    action: row.action,
    summary: row.summary,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
    ...readChanges(row.changes),
  }));
}

export type RecentActivityDto = ActivityEventDto & { entityType: ActivityEntity; entityId: string };

/**
 * The newest events of a whole organization (the dashboard's "recent activity"), read with the caller's own session. Newest
 * first; the id breaks ties so the order is stable.
 */
export async function listRecentActivity(
  supabase: Client,
  orgId: string,
  limit = 10,
): Promise<RecentActivityDto[]> {
  const { data, error } = await supabase
    .from("activity_events")
    .select("id, entity_type, entity_id, action, summary, actor_user_id, created_at, changes")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Row & { entity_type: string; entity_id: string }>).map((row) => ({
    id: row.id,
    entityType: row.entity_type as ActivityEntity,
    entityId: row.entity_id,
    action: row.action,
    summary: row.summary,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
    ...readChanges(row.changes),
  }));
}
