import { okItem } from "@/lib/api/envelope";
import { BadRequestError } from "@/lib/api/errors";
import { withOrgApi } from "@/lib/api/handler";
import { completeTaskSchema } from "@/features/tasks/schema";
import { completeForOrg } from "@/features/tasks/service";
import { parseBody, uuid } from "@/lib/validation";

/**
 * POST /api/v1/tasks/:id/complete: `{ completed: true | false, expectedUpdatedAt, status? }`. Completing sets status
 * `done` and stamps `completedAt`; reopening clears it and returns the task to `todo` (or `status`). Asking for the state
 * the task is already in is a 200 that changes and logs nothing. Owner, admin and member.
 */
export const POST = withOrgApi<{ id: string }>(
  async ({ params, request, supabase, org }) => {
    const parsed = uuid().safeParse(params.id);
    if (!parsed.success) throw new BadRequestError("That task id is not valid.");
    const input = await parseBody(completeTaskSchema, request);
    return okItem(await completeForOrg(supabase, org, parsed.data, input));
  },
  { authorize: "records.write" },
);
