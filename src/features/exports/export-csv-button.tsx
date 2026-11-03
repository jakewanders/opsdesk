"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { notify } from "@/components/shared/toast";
import { Button } from "@/components/ui/button";
import { apiDownload, isClientApiError } from "@/lib/api-client/api-fetch";
import { useApi } from "@/lib/api-client/provider";
import { saveBlob } from "@/lib/api-client/save-file";

type Props = {
  /** What is exported, as the export API names it. */
  entity: "customers" | "opportunities" | "tasks" | "reports";
  /** The view's own API query (filters, sort, range) exactly as the list or page sends it: the file carries the same filters. */
  query: Record<string, string | number | undefined>;
  /** Singular noun for messages: "customer list", "report". */
  noun: string;
};

/**
 * "Export CSV" (PRD F13): downloads the rows the person is looking at, from `GET /exports/:entity` with the view's active filters and
 * sort (`page` and `limit` are ignored by the server: an export is the whole filtered set, at most 10,000 rows). Shows progress while the
 * file is prepared, a toast when it is saved, and, when it cannot be, the server's own words (for example the row cap and how to narrow
 * it) with the request id. Every role that can read can export, so the button is always offered.
 */
export function ExportCsvButton({ entity, query, noun }: Props) {
  const { organizationId } = useApi();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const { blob, filename } = await apiDownload(`/exports/${entity}`, { organizationId, query });
      const name = filename ?? `${entity}.csv`;
      saveBlob(blob, name);
      notify.success(`${noun[0].toUpperCase()}${noun.slice(1)} exported`, name);
    } catch (e) {
      notify.error(
        `The ${noun} could not be exported`,
        isClientApiError(e)
          ? `${e.message}${e.requestId ? ` (request ${e.requestId})` : ""}`
          : "Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => void download()}
      disabled={busy}
      aria-busy={busy}
    >
      <Download aria-hidden="true" />
      {busy ? "Preparing CSV…" : "Export CSV"}
    </Button>
  );
}
