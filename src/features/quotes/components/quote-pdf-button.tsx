"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { notify } from "@/components/shared/toast";
import { Button } from "@/components/ui/button";
import { apiDownload, isClientApiError } from "@/lib/api-client/api-fetch";
import { useApi } from "@/lib/api-client/provider";

/**
 * "Download PDF" (every role, any status). The file comes from `GET /quotes/:id/pdf` with the workspace header, so it works the same
 * for someone in several workspaces; the browser then saves it under the name the server chose. A failure is said in words.
 */
export function QuotePdfButton({ quoteId, quoteNumber }: { quoteId: string; quoteNumber: string }) {
  const { organizationId } = useApi();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const { blob, filename } = await apiDownload(`/quotes/${quoteId}/pdf`, { organizationId });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename ?? `${quoteNumber}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      notify.success("PDF downloaded", `${quoteNumber}.pdf`);
    } catch (e) {
      notify.error(
        "The PDF could not be downloaded",
        isClientApiError(e)
          ? `${e.message}${e.requestId ? ` (request ${e.requestId})` : ""}`
          : "Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button type="button" variant="outline" onClick={() => void download()} disabled={busy}>
      <Download aria-hidden="true" />
      {busy ? "Preparing PDF…" : "Download PDF"}
    </Button>
  );
}
