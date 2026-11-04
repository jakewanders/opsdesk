"use client";

import { CircleCheck, CircleX, Clock, FilePen, Send, type LucideIcon } from "lucide-react";
import { useIsFresh } from "@/lib/motion/fresh";
import { cn } from "@/lib/utils";
import type { QuoteStatus as Status } from "../schema";

const ICONS: Record<Status, LucideIcon> = {
  draft: FilePen,
  sent: Send,
  approved: CircleCheck,
  rejected: CircleX,
  expired: Clock,
};

/**
 * The icon of a quote's status. It is its own client component so `QuoteStatus` (and the labels beside it) can stay usable from
 * server components: a quote that was just approved settles its check in once, which needs the fresh-id store.
 */
export function QuoteStatusIcon({ status, id }: { status: Status; id?: string }) {
  const Icon = ICONS[status];
  const fresh = useIsFresh(id ?? "");
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        "size-4 shrink-0 text-muted-foreground",
        fresh && status === "approved" && "animate-settle text-success",
      )}
    />
  );
}
