import { z } from "zod";
import { choice, email } from "@/lib/validation";

/** Roles an invitation can carry. `owner` is never invitable: an owner is made by promoting an existing member. */
export const INVITE_ROLES = ["admin", "member", "viewer"] as const;
export const MEMBER_ROLES = ["owner", "admin", "member", "viewer"] as const;

/** Body of POST /api/v1/invitations. Unknown fields are refused, so an organization or inviter cannot be injected. */
export const createInvitationSchema = z.strictObject({
  email: email(),
  role: choice(INVITE_ROLES),
});

/** Body of PATCH /api/v1/members/:userId. */
export const changeRoleSchema = z.strictObject({ role: choice(MEMBER_ROLES) });

/**
 * Body of POST /api/v1/invitations/accept. The token's shape is not checked here: the database answers `invalid` for
 * anything that is not a live token, so a malformed and an unknown token look the same to the caller.
 */
export const acceptInvitationSchema = z.strictObject({ token: z.string().min(1).max(200) });

export type InvitationDto = {
  id: string;
  email: string;
  role: string;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
  /** True when the 7 days have passed: the invitation can no longer be accepted but is still listed until revoked. */
  expired: boolean;
};
