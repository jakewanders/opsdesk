import { okItem } from "@/lib/api/envelope";
import { withApi } from "@/lib/api/handler";
import { loadMemberships } from "@/lib/api/org-context";
import { toWorkspaces } from "@/lib/api/organizations";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/v1/session: who is calling, which workspaces they belong to, and (for a guest) when the demo expires.
 * Everything is read with the caller's own session, so RLS decides what exists.
 */
export const GET = withApi(async ({ user }) => {
  const supabase = await createClient();
  const [memberships, profile] = await Promise.all([
    loadMemberships(supabase, user!.id),
    supabase.from("profiles").select("display_name").eq("id", user!.id).maybeSingle(),
  ]);
  if (profile.error) throw profile.error;
  const workspaces = toWorkspaces(memberships);
  const demo = workspaces.find((w) => w.kind === "demo") ?? null;
  return okItem({
    user: {
      id: user!.id,
      displayName: profile.data?.display_name ?? null,
      // A guest has no email; a member's own address is theirs to see.
      email: user!.isAnonymous ? null : user!.email,
      isAnonymous: user!.isAnonymous,
    },
    organizations: workspaces,
    demo: demo
      ? {
          organizationId: demo.id,
          expiresAt: demo.expiresAt,
          secondsRemaining: demo.secondsRemaining,
          expired: demo.expired,
        }
      : null,
  });
});
