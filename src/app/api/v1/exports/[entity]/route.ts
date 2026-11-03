import { withOrgApi } from "@/lib/api/handler";
import { buildExport } from "@/features/exports/service";

type Params = { entity: string };

/**
 * GET /api/v1/exports/:entity: a CSV download of `customers`, `opportunities`, `tasks` or `reports` (anything else is a 404).
 * The query string is the matching list endpoint's (same filters, `sort`, `order`; `page` and `limit` are ignored: an export is the
 * whole filtered set) or, for `reports`, the reports endpoint's (`range`, or `from` and `to`). At most 10,000 rows (422 beyond). Text
 * cells that a spreadsheet could run as a formula are written as inert text; the file ends each row with `exported_at`, and a demo
 * workspace's file also carries a `Sample / fictional data` column. `bom=true` adds a UTF-8 byte-order mark for Excel. Streamed. Any
 * member, viewers included, can export; another workspace's rows are never included.
 */
export const GET = withOrgApi<Params>(
  async ({ params, request, supabase, org }) => {
    const file = await buildExport(supabase, org, params.entity, new URL(request.url).searchParams);
    return new Response(file.body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "X-Export-Rows": String(file.rows),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  },
  { authorize: "records.read" },
);
