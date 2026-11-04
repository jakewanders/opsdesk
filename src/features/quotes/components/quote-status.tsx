import type { QuoteStatus as Status } from "../schema";
import { QuoteStatusBadge } from "./quote-status-badge";

export { QUOTE_STATUS_LABELS } from "./status-labels";

/** A quote's status as an icon AND a word, never colour alone (PRD 9.3). Safe to use from server components. */
export function QuoteStatus({ status, id }: { status: Status; id?: string }) {
  return <QuoteStatusBadge status={status} id={id} />;
}
