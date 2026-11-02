import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrgContext } from "@/lib/api/org-context";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError } from "@/lib/api/errors";
import { assertCan } from "@/lib/permissions";
import type { Database } from "@/lib/supabase/database.types";

export type MemberDto = { userId: string; role: string; displayName: string; joinedAt: string };

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
    joinedAt: m.joined_at,
  }));
}

export type InvitationDto = import("./schema").InvitationDto;

/** The stable error for each way redemption can be refused (the RPC returns the reason instead of raising). */
const ACCEPT_ERRORS: Record<string, () => Error> = {
  invalid: () => new NotFoundError("This invitation link is not valid.", "INVITATION_INVALID"),
  revoked: () =>
    new ConflictError("This invitation was withdrawn. Ask for a new one.", "INVITATION_REVOKED"),
  used: () => new ConflictError("This invitation was already used.", "INVITATION_USED"),
  expired: () =>
    new ConflictError("This invitation has expired. Ask for a new one.", "INVITATION_EXPIRED"),
  email_unverified: () =>
    new ForbiddenError(
      "Confirm your email address first, then open the link again.",
      "EMAIL_UNVERIFIED",
    ),
  email_mismatch: () =>
    new ForbiddenError(
      "This invitation was sent to a different email address than the one you are signed in with.",
      "EMAIL_MISMATCH",
    ),
  rate_limited: () =>
    new RateLimitError("Too many attempts. Wait a few minutes and try again.", 900),
};

/** Open invitations (not accepted, not revoked) of the active workspace. Metadata only: no token, no hash. */
export async function listInvitations(
  supabase: SupabaseClient<Database>,
  ctx: OrgContext,
): Promise<InvitationDto[]> {
  assertCan(ctx.role, ctx.kind, "members.manage");
  const { data, error } = await supabase
    .from("invitations")
    .select("id, email_normalized, role, invited_by, created_at, expires_at")
    .eq("organization_id", ctx.org.id)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const now = Date.now();
  return (data ?? []).map((i) => ({
    id: i.id,
    email: i.email_normalized,
    role: i.role,
    invitedBy: i.invited_by,
    createdAt: i.created_at,
    expiresAt: i.expires_at,
    expired: Date.parse(i.expires_at) <= now,
  }));
}

/** Creates an invitation. The plaintext token is in the result once; only its hash is stored. */
export async function createInvitation(
  supabase: SupabaseClient<Database>,
  ctx: OrgContext,
  input: { email: string; role: string },
): Promise<{ id: string; token: string; expiresAt: string }> {
  assertCan(ctx.role, ctx.kind, "members.manage");
  const { data, error } = await supabase.rpc("create_invitation", {
    p_org_id: ctx.org.id,
    p_email: input.email,
    p_role: input.role,
  });
  if (error) throw error;
  return data as { id: string; token: string; expiresAt: string };
}

export async function revokeInvitation(
  supabase: SupabaseClient<Database>,
  ctx: OrgContext,
  id: string,
): Promise<void> {
  assertCan(ctx.role, ctx.kind, "members.manage");
  const { error } = await supabase.rpc("revoke_invitation", { p_invitation_id: id });
  if (error) throw error;
}

/** Changes a member's role, or removes them. Owner rules and the last-owner guard are enforced by the database. */
export async function changeMembership(
  supabase: SupabaseClient<Database>,
  ctx: OrgContext,
  userId: string,
  change: { role: string } | { remove: true },
): Promise<{ userId: string; role: string | null }> {
  assertCan(ctx.role, ctx.kind, "members.manage");
  const { data, error } = await supabase.rpc("change_membership", {
    p_org_id: ctx.org.id,
    p_user_id: userId,
    ...("remove" in change ? { p_remove: true } : { p_new_role: change.role }),
  });
  if (error) throw error;
  return data as { userId: string; role: string | null };
}

/** Redeems a token for the signed-in user. Not tied to an active workspace: the invitation names it. */
export async function acceptInvitation(
  supabase: SupabaseClient<Database>,
  token: string,
): Promise<{ organizationId: string; role: string }> {
  const { data, error } = await supabase.rpc("redeem_invitation", { p_token: token });
  if (error) throw error;
  const result = data as { ok: boolean; reason?: string; organizationId?: string; role?: string };
  if (!result.ok) throw (ACCEPT_ERRORS[result.reason ?? "invalid"] ?? ACCEPT_ERRORS.invalid)();
  return { organizationId: result.organizationId!, role: result.role! };
}
