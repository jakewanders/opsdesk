import type { SupabaseClient } from "@supabase/supabase-js";

export type RestartResult =
  | { ok: true; organizationId: string }
  | { ok: false; reason: "busy" | "not_guest" | "failed"; message: string };

/**
 * Restarts the demo for a guest whose workspace expired. The guest's anonymous session is still valid, so no
 * new CAPTCHA is needed: `bootstrap_demo_workspace` deletes the caller's own expired demo and creates a fresh,
 * freshly seeded one (one demo per identity, enforced by the database). Never converts a demo into a real
 * organization: the old one is removed and the new one starts empty of the guest's work.
 */
export async function restartDemo(
  supabase: SupabaseClient<any, any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any -- generic over any Database
): Promise<RestartResult> {
  try {
    const { data, error } = await supabase.rpc("bootstrap_demo_workspace");
    if (error) {
      if (error.code === "OD429") {
        return {
          ok: false,
          reason: "busy",
          message: "The demo is very busy right now. Please try again in a few minutes.",
        };
      }
      if (error.code === "OD403") {
        return {
          ok: false,
          reason: "not_guest",
          message: "The live demo is for guest visitors. Sign out to try it.",
        };
      }
      return {
        ok: false,
        reason: "failed",
        message: "We could not start a new demo. Try again in a moment.",
      };
    }
    return { ok: true, organizationId: (data as { organization_id: string }).organization_id };
  } catch {
    return {
      ok: false,
      reason: "failed",
      message: "We could not start a new demo. Try again in a moment.",
    };
  }
}
