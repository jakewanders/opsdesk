import { okItem, created } from "@/lib/api/envelope";
import { withOrgApi } from "@/lib/api/handler";
import { previewCustomerImport } from "@/features/customers/import/service";
import { PREVIEW_BODY_LIMIT, previewImportSchema } from "@/features/customers/import/schema";
import { parseBody } from "@/lib/validation";

/**
 * POST /api/v1/imports/customers/preview: validates an uploaded customers CSV and writes nothing but the preview job. The body is
 * `{ content }`, the file's bytes as base64 (at most 2 MB of file, 1,000 data rows, UTF-8). 201 for a new job, 200 when the same file
 * was already previewed (or imported) in this workspace within the hour: the response then describes that same job. Owner, admin and
 * member only; a viewer gets 403.
 */
export const POST = withOrgApi(
  async ({ request, supabase, org }) => {
    const { content } = await parseBody(previewImportSchema, request);
    const { reused, data } = await previewCustomerImport(supabase, org, content);
    return reused ? okItem(data) : created(data);
  },
  { authorize: "records.write", feature: "csvImport", maxBodyBytes: PREVIEW_BODY_LIMIT },
);
