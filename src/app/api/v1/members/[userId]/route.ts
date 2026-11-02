import { noContent, okItem } from "@/lib/api/envelope";
import { BadRequestError } from "@/lib/api/errors";
import { withOrgApi } from "@/lib/api/handler";
import { changeRoleSchema } from "@/features/members/schema";
import { changeMembership } from "@/features/members/service";
import { parseBody, uuid } from "@/lib/validation";

type Params = { userId: string };

function memberId(params: Params): string {
  const parsed = uuid().safeParse(params.userId);
  if (!parsed.success) throw new BadRequestError("That member id is not valid.");
  return parsed.data;
}

/**
 * PATCH /api/v1/members/:userId: change a member's role. Owner and admin only; an admin cannot make an owner, change an
 * owner or promote themselves (403 `OWNER_GRANT`, `OWNER_PROTECTED`); the last owner cannot be demoted (409 `LAST_OWNER`).
 */
export const PATCH = withOrgApi<Params>(
  async ({ params, request, supabase, org }) => {
    const { role } = await parseBody(changeRoleSchema, request);
    return okItem(await changeMembership(supabase, org, memberId(params), { role }));
  },
  { authorize: "members.manage" },
);

/** DELETE /api/v1/members/:userId: remove a member (204). Same rules as PATCH; the last owner cannot be removed (409 `LAST_OWNER`). */
export const DELETE = withOrgApi<Params>(
  async ({ params, supabase, org }) => {
    await changeMembership(supabase, org, memberId(params), { remove: true });
    return noContent();
  },
  { authorize: "members.manage" },
);
