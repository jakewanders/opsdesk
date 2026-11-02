import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrgContext } from "@/lib/api/org-context";
import { assertCan } from "@/lib/permissions";
import type { Database } from "@/lib/supabase/database.types";

export type MemberDto = { userId: string; role: string; displayName: string };

/**
 * The members of the active workspace (for owner and assignee pickers). Everyone who can read the workspace may see
 * who else is in it; the database function re-checks membership and returns only id, role and display name.
 */
export async function listMembers(
  supabase: SupabaseClient<Database>,
  ctx: OrgContext,
): Promise<MemberDto[]> {
  assertCan(ctx.role, ctx.kind, "records.read");
  const { data, error } = await supabase.rpc("list_workspace_members", { p_org_id: ctx.org.id });
  if (error) throw error;
  return (data ?? []).map((m) => ({
    userId: m.user_id,
    role: m.role,
    displayName: m.display_name,
  }));
}
