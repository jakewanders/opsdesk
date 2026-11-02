import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceState } from "./route-guard";

type MembershipRow = {
  organizations: { id: string; kind: string; expires_at: string | null } | null;
};

/**
 * Reads the caller's own workspaces with their session (so RLS decides what is visible) and
 * summarizes them for routing. Any error, including "permission denied" before the tenancy policies
 * exist, yields `unknown`, which never redirects.
 */
export async function resolveWorkspaceState(
  supabase: SupabaseClient<any, any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any -- generic over any Database
  userId: string,
  now: Date = new Date(),
  /** The selected-workspace preference cookie, if any. */
  activeOrgId?: string | null,
): Promise<WorkspaceState> {
  try {
    const { data, error } = await supabase
      .from("memberships")
      .select("organizations(id, kind, expires_at)")
      .eq("user_id", userId)
      .limit(50);
    if (error || !data) return "unknown";
    const rows = data as unknown as MembershipRow[];
    if (rows.length === 0) return "none";
    const isUsable = (org: NonNullable<MembershipRow["organizations"]>) =>
      org.kind !== "demo" ||
      (org.expires_at !== null && new Date(org.expires_at).getTime() > now.getTime());
    const usableOrgs = rows.flatMap((row) =>
      row.organizations && isUsable(row.organizations) ? [row.organizations] : [],
    );
    const usable = usableOrgs.length > 0;
    // Rows whose organization is hidden are not proof of anything: treat as unknown.
    if (!usable && rows.every((row) => row.organizations === null)) return "unknown";
    // Several usable workspaces: a valid selection is required (the cookie must name one the caller belongs to).
    if (usableOrgs.length > 1) {
      const chosen = activeOrgId
        ? usableOrgs.some((o) => o.id === activeOrgId.toLowerCase())
        : false;
      return chosen ? "ready" : "choose";
    }
    return usable ? "ready" : "expired-demo";
  } catch {
    return "unknown";
  }
}
