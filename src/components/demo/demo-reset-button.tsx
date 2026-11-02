"use client";

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { notify } from "@/components/shared/toast";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-client/api-fetch";
import { newIdempotencyKey } from "@/lib/api-client/idempotency";
import { useClearApiCache } from "@/lib/api-client/provider";

/**
 * "Reset Demo" for a guest: a confirmation that says exactly what happens, then `POST /api/v1/demo/reset`. On success
 * the client cache is cleared, a toast confirms, and the page's server data is re-read, so the sample data is back
 * without a manual refresh. A throttled reset keeps the dialog open and says how long to wait. The server is the
 * authority: this button only exists in the guest banner.
 */
export function DemoResetButton() {
  const router = useRouter();
  const clearCache = useClearApiCache();
  const [open, setOpen] = useState(false);
  // One key per intent: a failed attempt keeps it (a retry is the same request), a success drops it.
  const key = useRef<string | null>(null);

  async function reset() {
    key.current ??= newIdempotencyKey();
    await apiFetch("/demo/reset", { method: "POST", idempotencyKey: key.current });
    key.current = null;
    clearCache();
    notify.success("Demo reset", "The sample data is back as it was.");
    router.refresh();
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <RotateCcw aria-hidden="true" />
        Reset Demo
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Reset the demo?"
        description={
          <>
            <p>Your demo changes will be replaced with the original sample data.</p>
            <p className="mt-2">
              This cannot be undone. The 24-hour timer does not restart. You can reset once a
              minute.
            </p>
          </>
        }
        confirmLabel="Reset demo"
        onConfirm={reset}
      />
    </>
  );
}
