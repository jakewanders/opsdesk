import type { SupabaseClient } from "@supabase/supabase-js";

export type BootstrapResult = {
  organizationId: string;
  expiresAt: string;
  /** False when the guest already had a live demo (a reopen or a retry). */
  created: boolean;
};

/**
 * Creates or returns the calling guest's demo workspace through `bootstrap_demo_workspace` (anonymous only,
 * locked per user, one demo per identity, quota and capacity checked in the database). Errors are thrown as the
 * database raised them so the API layer maps them (OD429 capacity -> 429, OD403 not a guest -> 403).
 */
export async function bootstrapDemoWorkspace(
  supabase: SupabaseClient<any, any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any -- generic over any Database
): Promise<BootstrapResult> {
  const { data, error } = await supabase.rpc("bootstrap_demo_workspace");
  if (error) throw error;
  const row = data as { organization_id: string; expires_at: string; created: boolean };
  return { organizationId: row.organization_id, expiresAt: row.expires_at, created: row.created };
}
