import type { SupabaseClient } from "@supabase/supabase-js";
import { loadMemberships } from "@/lib/api/org-context";
import {
  createOrganizationSchema,
  toWorkspaces,
  type WorkspaceSummary,
} from "@/lib/api/organizations";
import { zodFieldErrors } from "@/lib/api/to-api-error";

export type CreateWorkspaceResult =
  | { ok: true; id: string }
  | {
      ok: false;
      reason: "guest" | "invalid" | "limit" | "failed";
      message: string;
      fieldErrors?: Record<string, string[]>;
    };

type Db = SupabaseClient<any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- generic over any Database

const GUEST_MESSAGE = "Create an account to keep your data. Guests cannot create workspaces.";

/**
 * Creates a real workspace for the signed-in caller: validates the form with the same schema as
 * `POST /api/v1/organizations`, then calls `create_real_organization` (the only way to create one).
 * Guests never reach the database.
 */
export async function createWorkspace(
  supabase: Db,
  user: { isAnonymous: boolean },
  raw: { name: string; industry: string; timezone: string },
): Promise<CreateWorkspaceResult> {
  if (user.isAnonymous) return { ok: false, reason: "guest", message: GUEST_MESSAGE };
  const parsed = createOrganizationSchema.safeParse({
    name: raw.name,
    industry: raw.industry,
    timezone: raw.timezone.trim() === "" ? undefined : raw.timezone,
  });
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      message: "Please correct the highlighted fields.",
      fieldErrors: zodFieldErrors(parsed.error),
    };
  }
  try {
    const { data, error } = await supabase.rpc("create_real_organization", {
      org_name: parsed.data.name,
      org_industry: parsed.data.industry ?? undefined,
      org_timezone: parsed.data.timezone ?? "UTC",
    });
    if (error) {
      if (error.code === "OD403") return { ok: false, reason: "guest", message: GUEST_MESSAGE };
      if (error.code === "OD429")
        return {
          ok: false,
          reason: "limit",
          message: "You have reached the limit of workspaces for one account.",
        };
      if (error.code === "OD422")
        return {
          ok: false,
          reason: "invalid",
          message: "Check the workspace details and try again.",
        };
      return {
        ok: false,
        reason: "failed",
        message: "We could not create the workspace. Try again in a moment.",
      };
    }
    return { ok: true, id: data as string };
  } catch {
    return {
      ok: false,
      reason: "failed",
      message: "We could not create the workspace. Try again in a moment.",
    };
  }
}

/** The caller's workspaces, read with their own session (RLS: never another tenant's). */
export async function listWorkspaces(supabase: Db, userId: string): Promise<WorkspaceSummary[]> {
  return toWorkspaces(await loadMemberships(supabase, userId));
}

/** True only if `orgId` is one of the caller's workspaces. A foreign or unknown id is simply "no". */
export async function isMemberOf(supabase: Db, userId: string, orgId: string): Promise<boolean> {
  return (await listWorkspaces(supabase, userId)).some((w) => w.id === orgId.toLowerCase());
}
