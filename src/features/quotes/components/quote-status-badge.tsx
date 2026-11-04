"use client";

import { CircleCheck, CircleX, Clock, FilePen, Send, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { useIsFresh } from "@/lib/motion/fresh";
import { cn } from "@/lib/utils";
import type { QuoteStatus as Status } from "../schema";
import { QUOTE_STATUS_LABELS } from "./status-labels";

const ICONS: Record<Status, LucideIcon> = {
  draft: FilePen,
  sent: Send,
  approved: CircleCheck,
  rejected: CircleX,
  expired: Clock,
};

/**
 * A quote's status as an icon AND a word, never colour alone (PRD 9.3). It is a client component so a quote that was just
 * approved can settle its check in once (the fresh-id store), and so a change of status can fade in. It does NOT fade on first
 * render: a half-transparent badge fails automated contrast checks, and nothing changed yet.
 */
export function QuoteStatusBadge({ status, id }: { status: Status; id?: string }) {
  const Icon = ICONS[status];
  const fresh = useIsFresh(id ?? "");
  const [previous, setPrevious] = useState(status);
  const [changed, setChanged] = useState(false);
  if (previous !== status) {
    setPrevious(status);
    setChanged(true);
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap",
        changed && "duration-(--motion-base) animate-in fade-in",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0 text-muted-foreground",
          fresh && status === "approved" && "animate-settle text-success",
        )}
      />
      {QUOTE_STATUS_LABELS[status]}
    </span>
  );
}
