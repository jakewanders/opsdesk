import { BadRequestError } from "@/lib/api/errors";
import { withOrgApi } from "@/lib/api/handler";
import { pdfForOrg } from "@/features/quotes/service";
import { uuid } from "@/lib/validation";

/**
 * GET /api/v1/quotes/:id/pdf: the quote as a PDF download (`Content-Disposition: attachment; filename="Q-000123.pdf"`). Every role
 * may export. A demo workspace's pages carry "Sample / fictional data". Another workspace's quote is a 404. Nothing is emailed.
 */
export const GET = withOrgApi<{ id: string }>(
  async ({ params, supabase, org }) => {
    const id = uuid().safeParse(params.id);
    if (!id.success) throw new BadRequestError("That quote id is not valid.");
    const { bytes, filename } = await pdfForOrg(supabase, org, id.data);
    return new Response(bytes as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, no-store",
      },
    });
  },
  { authorize: "export.run", feature: "quotes" },
);
