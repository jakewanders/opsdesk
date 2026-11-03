import { createHash } from "node:crypto";
import { okItem } from "@/lib/api/envelope";
import { withOrgApi } from "@/lib/api/handler";
import { readIdempotencyKey, withIdempotency } from "@/lib/api/idempotency";
import { commitCustomerImport } from "@/features/customers/import/service";
import { PREVIEW_BODY_LIMIT, commitImportSchema } from "@/features/customers/import/schema";
import { parseBody } from "@/lib/validation";

/**
 * POST /api/v1/imports/customers/commit: imports the valid rows of a previewed file, once. The body is `{ importJobId, content }`: the
 * job from the preview and the same file again (base64); the rows are re-read and re-validated here, never taken from the preview.
 * Invalid rows are skipped; the answer says how many rows were `imported`, `rejected`, `skippedDuplicates` and which chunks failed
 * (`failedChunks`). A repeat of the same job (a double click, a retry, a second tab) returns the original result and writes nothing;
 * an `Idempotency-Key` additionally replays the exact response. A demo workspace stops at its customer cap with 429 `DEMO_CAP` and the
 * partial result in `error.meta.result`. Owner, admin and member; only the person who started the import or an owner or admin may finish it.
 */
export const POST = withOrgApi(
  async ({ request, supabase, org }) => {
    const key = readIdempotencyKey(request);
    const input = await parseBody(commitImportSchema, request);
    return withIdempotency(
      supabase,
      {
        route: "POST /api/v1/imports/customers/commit",
        key,
        payload: {
          org: org.org.id,
          importJobId: input.importJobId,
          file: createHash("sha256").update(input.content).digest("hex"),
        },
      },
      async () => okItem(await commitCustomerImport(supabase, org, input)),
    );
  },
  { authorize: "records.write", feature: "csvImport", maxBodyBytes: PREVIEW_BODY_LIMIT },
);
