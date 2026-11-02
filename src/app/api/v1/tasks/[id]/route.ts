import { noContent, okItem } from "@/lib/api/envelope";
import { BadRequestError } from "@/lib/api/errors";
import { withOrgApi } from "@/lib/api/handler";
import { updateTaskSchema } from "@/features/tasks/schema";
import { archiveForOrg, getForOrg, updateForOrg } from "@/features/tasks/service";
import { parseBody, uuid } from "@/lib/validation";

type Params = { id: string };

/** The id in the path: a malformed one is a 400, a well-formed one the caller cannot see is a 404. */
function taskId(params: Params): string {
  const parsed = uuid().safeParse(params.id);
  if (!parsed.success) throw new BadRequestError("That task id is not valid.");
  return parsed.data;
}

/** GET /api/v1/tasks/:id: the task with its linked customer's name and deal's title. */
export const GET = withOrgApi<Params>(
  async ({ params, supabase, org }) => okItem(await getForOrg(supabase, org, taskId(params))),
  { authorize: "records.read" },
);

/** PATCH /api/v1/tasks/:id: partial update. Send `expectedUpdatedAt` as last seen: a stale one is 409 `STALE_EDIT`. */
export const PATCH = withOrgApi<Params>(
  async ({ params, request, supabase, org }) => {
    const id = taskId(params);
    const input = await parseBody(updateTaskSchema, request);
    return okItem(await updateForOrg(supabase, org, id, input));
  },
  { authorize: "records.write" },
);

/** DELETE /api/v1/tasks/:id: archive (soft delete), idempotent, 204. */
export const DELETE = withOrgApi<Params>(
  async ({ params, supabase, org }) => {
    await archiveForOrg(supabase, org, taskId(params));
    return noContent();
  },
  { authorize: "records.write" },
);
