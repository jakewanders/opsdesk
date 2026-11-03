"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { notify } from "@/components/shared/toast";
import { Button } from "@/components/ui/button";
import { apiDownload, isClientApiError } from "@/lib/api-client/api-fetch";
import { useApi } from "@/lib/api-client/provider";
import { saveBlob } from "@/lib/api-client/save-file";

/** "Export CSV": the file for the range on screen, from `GET /exports/reports` (the same query as the page). */
export function ExportReportButton({
  query,
}: {
  query: Record<string, string | number | undefined>;
}) {
  const { organizationId } = useApi();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const { blob, filename } = await apiDownload("/exports/reports", { organizationId, query });
      saveBlob(blob, filename ?? "reports.csv");
      notify.success("Report exported", filename ?? "reports.csv");
    } catch (e) {
      notify.error(
        "The report could not be exported",
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
      {busy ? "Preparing CSV…" : "Export CSV"}
    </Button>
  );
}
