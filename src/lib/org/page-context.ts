import "server-only";
import { cookies } from "next/headers";
import { loadMemberships, selectOrg, type OrgContext } from "@/lib/api/org-context";
import { getCurrentUser } from "@/lib/supabase/current-user";
import { createClient } from "@/lib/supabase/server";
import { ACTIVE_ORG_COOKIE } from "./active-org";

/**
 * The verified organization context for a server-rendered page: the signed-in user, their role and the workspace
 * chosen by the preference cookie (re-verified against memberships; an unknown or foreign id falls back to the only
 * workspace, or to none). Null when there is no single usable workspace: the proxy sends such users to the chooser.
 */
export async function getPageOrgContext(): Promise<{
  ctx: OrgContext;
  supabase: Awaited<ReturnType<typeof createClient>>;
} | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const supabase = await createClient();
  const memberships = await loadMemberships(supabase, user.id);
  const preferred = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value ?? null;
  for (const header of [preferred, null]) {
    try {
      return { ctx: selectOrg(user, memberships, header, {}), supabase };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
