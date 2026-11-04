"use client";

import { Check, Link2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { notify } from "@/components/shared/toast";
import { Button } from "@/components/ui/button";

/**
 * "Copy link": copies the address of the view as it is now (search, filters, sort, page and all). The address holds only what the URL
 * state holds, so anyone in the same workspace who opens it sees the same view; it has no data in it beyond what the person typed in the
 * search box. Where the clipboard is not available the person is told, in words, to copy it from the address bar.
 */
export function CopyLinkButton({ className }: { className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      notify.success("Link copied", "Anyone in this workspace who opens it sees this view.");
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      notify.error(
        "The link could not be copied",
        "Copy the address from your browser's address bar instead.",
      );
    }
  }
  return (
    <Button type="button" variant="outline" className={className} onClick={() => void copy()}>
      {copied ? (
        <Check aria-hidden="true" data-testid="copied-icon" />
      ) : (
        <Link2 aria-hidden="true" />
      )}
      Copy link
    </Button>
  );
}
