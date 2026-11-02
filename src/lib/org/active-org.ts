import type { WorkspaceSummary } from "@/lib/api/organizations";

/**
 * The selected workspace is only a UI PREFERENCE kept in this cookie. It is never authorization: the server
 * re-proves membership against the caller's own memberships on every request (RLS), and a cookie naming anything
 * the caller does not belong to is simply ignored, so tampering can neither reach another tenant nor break the page.
 */
export const ACTIVE_ORG_COOKIE = "od_active_org";

export type ActiveSelection =
  { status: "selected"; workspace: WorkspaceSummary } | { status: "choose" } | { status: "none" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which workspace is active: the one in the cookie if (and only if) the caller belongs to it; otherwise the only
 * workspace they have; otherwise they must choose explicitly (no silent default among several).
 */
export function resolveActiveWorkspace(
  cookieValue: string | undefined | null,
  workspaces: readonly WorkspaceSummary[],
): ActiveSelection {
  if (workspaces.length === 0) return { status: "none" };
  const id =
    typeof cookieValue === "string" && UUID.test(cookieValue) ? cookieValue.toLowerCase() : null;
  const preferred = id ? workspaces.find((w) => w.id === id) : undefined;
  if (preferred) return { status: "selected", workspace: preferred };
  if (workspaces.length === 1) return { status: "selected", workspace: workspaces[0] };
  return { status: "choose" };
}
