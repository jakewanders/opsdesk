"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * "Copy" beside a request ID (SIT-275): one press puts the ID on the clipboard so it can be pasted into a report. The button says
 * "Copied" for a moment; where the clipboard is not available it says so, and the ID stays on screen to be selected by hand.
 */
export function CopyRequestId({ requestId }: { requestId: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    let copiedOk = false;
    try {
      await navigator.clipboard.writeText(requestId);
      copiedOk = true;
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    // "Copied" is a quick confirmation; a failure message needs longer to read.
    timer.current = setTimeout(() => setState("idle"), copiedOk ? 1500 : 2500);
  }
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        onClick={() => void copy()}
        aria-label={`Copy request ID ${requestId}`}
      >
        {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {state === "copied" ? "Copied" : "Copy"}
      </Button>
      <span role="status" className="sr-only">
        {state === "copied"
          ? "Request ID copied"
          : state === "failed"
            ? "Could not copy. Select the request ID and copy it by hand."
            : ""}
      </span>
      {state === "failed" ? (
        <span className="text-muted-foreground" aria-hidden="true">
          Could not copy: select the ID instead.
        </span>
      ) : null}
    </>
  );
}
