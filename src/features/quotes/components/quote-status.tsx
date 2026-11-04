import { CircleCheck, CircleX, Clock, FilePen, Send, type LucideIcon } from "lucide-react";
import { useIsFresh } from "@/lib/motion/fresh";
import { cn } from "@/lib/utils";
import type { QuoteStatus as Status } from "../schema";

export const QUOTE_STATUS_LABELS: Record<Status, string> = {
  draft: "Draft",
  sent: "Sent",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
};
const ICONS: Record<Status, LucideIcon> = {
  draft: FilePen,
  sent: Send,
  approved: CircleCheck,
  rejected: CircleX,
  expired: Clock,
};

/** A quote's status as an icon AND a word, never colour alone (PRD 9.3). */
export function QuoteStatus({ status, id }: { status: Status; id?: string }) {
  const Icon = ICONS[status];
  // A quote that was just approved settles its check in once; a change of status fades in.
  const fresh = useIsFresh(id ?? "");
  return (
    <span
      key={status}
      className="inline-flex items-center gap-1.5 whitespace-nowrap duration-(--motion-base) animate-in fade-in"
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
