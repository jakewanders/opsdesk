"use client";

import { Button } from "@/components/ui/button";

/**
 * A line under a list's filters saying the list is narrowed to one related record (it was opened from that record's page), with a way
 * out. Words, not just a chip colour: "Showing only tasks linked to this customer."
 */
export function ScopeNote({ text, onClear }: { text: string; onClear: () => void }) {
  return (
    <p
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
    >
      <span>{text}</span>
      <Button type="button" variant="outline" size="sm" onClick={onClear}>
        Show all
      </Button>
    </p>
  );
}
