import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrgContext } from "@/lib/api/org-context";
import { assertCan } from "@/lib/permissions";
import type { Database } from "@/lib/supabase/database.types";
import { NotFoundError } from "@/lib/api/errors";
import { paginate } from "@/lib/validation";
import {
  listEntityActivity,
  readChanges,
  type ActivityEntity,
  type ActivityEventDto,
  type FieldChange,
} from "./repository";
import type { ActivityListQuery } from "./schema";

/** Everyone who can read the workspace can read its activity for a record. */
export async function activityFor(
  supabase: SupabaseClient<Database>,
  ctx: OrgContext,
  entityType: ActivityEntity,
  entityId: string,
): Promise<ActivityEventDto[]> {
  assertCan(ctx.role, ctx.kind, "records.read");
  return listEntityActivity(supabase, ctx.org.id, entityType, entityId);
}

/** One event of the workspace feed. */
export type ActivityItemDto = {
  id: string;
  entityType: ActivityEntity;
  entityId: string;
  action: string;
  summary: string;
  /** Null for the System. */
  actorUserId: string | null;
  /** `System`, a member's display name, or `Former member` when the person is no longer in the workspace. */
  actorName: string;
  /** Plain fields with old and new values. */
  changes: FieldChange[];
  /** Free-text fields that changed: only their names are ever stored. */
  contentChanged: string[];
  createdAt: string;
};

type Row = {
  id: string;
  entityType: ActivityEntity;
  entityId: string;
  action: string;
  summary: string;
  actorUserId: string | null;
  actorName: string | null;
  changes: unknown;
  createdAt: string;
};

/**
 * One page of the workspace's activity feed (newest first by default) for anyone who can read the workspace. The database
 * function answers only members, reads only this organization's events and names an actor only through its memberships.
 */
export async function listActivity(
  supabase: SupabaseClient<Database>,
  ctx: OrgContext,
  query: ActivityListQuery,
) {
  assertCan(ctx.role, ctx.kind, "records.read");
  const { offset } = paginate(query, 0);
  const { data, error } = await supabase.rpc("list_activity", {
    p_org_id: ctx.org.id,
    p_entity_type: query.entityType,
    p_entity_id: query.entityId,
    p_action: query.action,
    p_actor: query.actor && query.actor !== "system" ? query.actor : undefined,
    p_system_only: query.actor === "system",
    p_from: query.from,
    p_to: query.to,
    p_newest_first: query.order === "desc",
    p_limit: query.limit,
    p_offset: offset,
  });
  if (error) {
    if (error.code === "OD404") throw new NotFoundError("That workspace was not found.");
    throw error;
  }
  const result = data as unknown as { total: number; items: Row[] };
  const items: ActivityItemDto[] = result.items.map((row) => ({
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    summary: row.summary,
    actorUserId: row.actorUserId,
    actorName: row.actorName ?? "Former member",
    ...readChanges(row.changes),
    createdAt: row.createdAt,
  }));
  return { items, meta: paginate(query, result.total).meta };
}
