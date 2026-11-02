import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrgContext } from "@/lib/api/org-context";
import { assertCan } from "@/lib/permissions";
import type { Database } from "@/lib/supabase/database.types";
import { listEntityActivity, type ActivityEntity, type ActivityEventDto } from "./repository";

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
