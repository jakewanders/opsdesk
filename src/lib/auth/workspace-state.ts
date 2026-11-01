import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceState } from "./route-guard";

type MembershipRow = { organizations: { kind: string; expires_at: string | null } | null };

/**
 * Reads the caller's own workspaces with their session (so RLS decides what is visible) and
 * summarizes them for routing. Any error, including "permission denied" before the tenancy policies
 * exist, yields `unknown`, which never redirects.
 */
export async function resolveWorkspaceState(
  supabase: SupabaseClient<any, any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any -- generic over any Database
  userId: string,
  now: Date = new Date(),
): Promise<WorkspaceState> {
  try {
    const { data, error } = await supabase
      .from("memberships")
      .select("organizations(kind, expires_at)")
      .eq("user_id", userId)
      .limit(50);
    if (error || !data) return "unknown";
    const rows = data as unknown as MembershipRow[];
    if (rows.length === 0) return "none";
    const usable = rows.some((row) => {
      const org = row.organizations;
      if (!org) return false;
      if (org.kind !== "demo") return true;
      return org.expires_at !== null && new Date(org.expires_at).getTime() > now.getTime();
    });
    // Rows whose organization is hidden (null) are not proof of anything: treat as unknown.
    if (!usable && rows.every((row) => row.organizations === null)) return "unknown";
    return usable ? "ready" : "expired-demo";
  } catch {
    return "unknown";
  }
}
