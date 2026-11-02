import { CircleCheck, CircleDot, CirclePause } from "lucide-react";
import type { CustomerDto } from "../schema";

const STATUS = {
  lead: { label: "Lead", Icon: CircleDot },
  active: { label: "Active", Icon: CircleCheck },
  inactive: { label: "Inactive", Icon: CirclePause },
} as const;

export const STATUS_LABELS = { lead: "Lead", active: "Active", inactive: "Inactive" } as const;

/** Status as an icon AND a word, never colour alone (PRD 9.3). */
export function CustomerStatus({ status }: { status: CustomerDto["status"] }) {
  const { label, Icon } = STATUS[status];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      {label}
    </span>
  );
}
