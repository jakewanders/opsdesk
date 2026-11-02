import { okItem } from "@/lib/api/envelope";
import { BadRequestError } from "@/lib/api/errors";
import { withOrgApi } from "@/lib/api/handler";
import { moveStageSchema } from "@/features/opportunities/schema";
import { moveStageForOrg } from "@/features/opportunities/service";
import { parseBody, uuid } from "@/lib/validation";

/**
 * POST /api/v1/opportunities/:id/stage: the one way to change a deal's stage. Body: `stage`, `lostReason` (required for
 * `lost`) and `expectedUpdatedAt`. Owner, admin and member. 422 for lost without a reason, 409 when stale, 404 when the
 * deal is missing or in another workspace, 403 for a viewer or an expired demo. Moving to the current stage is a 200
 * that changes nothing.
 */
export const POST = withOrgApi<{ id: string }>(
  async ({ params, request, supabase, org }) => {
    const parsed = uuid().safeParse(params.id);
    if (!parsed.success) throw new BadRequestError("That opportunity id is not valid.");
    const input = await parseBody(moveStageSchema, request);
    return okItem(await moveStageForOrg(supabase, org, parsed.data, input));
  },
  { authorize: "records.write" },
);
