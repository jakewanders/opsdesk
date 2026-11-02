import { okList } from "@/lib/api/envelope";
import { withOrgApi } from "@/lib/api/handler";
import { listMembers } from "@/features/members/service";

/**
 * GET /api/v1/members: the members of the active workspace with their role and display name, sorted by name. Only
 * members can ask; nothing else about a person (no e-mail) is returned.
 */
export const GET = withOrgApi(async ({ supabase, org }) => {
  const members = await listMembers(supabase, org);
  return okList(members, { total: members.length });
});
