import { CircleCheck, CircleX, Clock, FilePen, Send, type LucideIcon } from "lucide-react";
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
export function QuoteStatus({ status }: { status: Status }) {
  const Icon = ICONS[status];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      {QUOTE_STATUS_LABELS[status]}
    </span>
  );
}
