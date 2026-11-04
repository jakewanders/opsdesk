import type { QuoteStatus as Status } from "../schema";
import { QuoteStatusIcon } from "./quote-status-icon";

export const QUOTE_STATUS_LABELS: Record<Status, string> = {
  draft: "Draft",
  sent: "Sent",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
};
/** A quote's status as an icon AND a word, never colour alone (PRD 9.3). */
export function QuoteStatus({ status, id }: { status: Status; id?: string }) {
  return (
    <span
      key={status}
      className="inline-flex items-center gap-1.5 whitespace-nowrap duration-(--motion-base) animate-in fade-in"
    >
      <QuoteStatusIcon status={status} id={id} />
      {QUOTE_STATUS_LABELS[status]}
    </span>
  );
}
