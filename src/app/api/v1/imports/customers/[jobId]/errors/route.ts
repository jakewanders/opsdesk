import { BadRequestError } from "@/lib/api/errors";
import { withOrgApi } from "@/lib/api/handler";
import { importErrorReport } from "@/features/customers/import/service";
import { uuid } from "@/lib/validation";

type Params = { jobId: string };

/**
 * GET /api/v1/imports/customers/:jobId/errors: the import's error report as a CSV download (row, field, code, a fixed explanation).
 * It is built from row numbers, field names and codes only, so it never repeats anything typed into the file. Any member can read it.
 */
export const GET = withOrgApi<Params>(
  async ({ params, supabase, org }) => {
    const id = uuid().safeParse(params.jobId);
    if (!id.success) throw new BadRequestError("That import id is not valid.");
    const { csv, truncated, jobId } = await importErrorReport(supabase, org, id.data);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="import-errors-${jobId.slice(0, 8)}.csv"`,
        "X-Report-Truncated": truncated ? "true" : "false",
        "Cache-Control": "private, no-store",
      },
    });
  },
  { authorize: "records.read", feature: "csvImport" },
);
