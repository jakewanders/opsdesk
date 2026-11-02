import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  CheckCircle2,
  CirclePlus,
  History,
  Pencil,
  RotateCcw,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import type { ActivityEntity, FieldChange } from "../repository";
import { FIELD_LABELS, showChange } from "../field-labels";
import { relativeTime } from "../relative-time";

export type TimelineItem = {
  id: string;
  action: string;
  /** The event's plain-text summary, already naming who did what. */
  summary: string;
  actorName: string;
  createdAt: string;
  changes: FieldChange[];
  /** Free-text fields that changed: only their NAMES are ever shown. */
  contentChanged: string[];
  /** The record this event is about; omit it on the record's own page. */
  entity?: { type: ActivityEntity; id: string; state: "active" | "archived" | "missing" };
};

const ACTIONS: Record<string, { label: string; Icon: LucideIcon }> = {
  created: { label: "Created", Icon: CirclePlus },
  updated: { label: "Updated", Icon: Pencil },
  archived: { label: "Archived", Icon: Archive },
  restored: { label: "Restored", Icon: ArchiveRestore },
  deleted: { label: "Deleted", Icon: Trash2 },
  stage_changed: { label: "Stage changed", Icon: ArrowRightLeft },
  completed: { label: "Completed", Icon: CheckCircle2 },
  reopened: { label: "Reopened", Icon: RotateCcw },
};
const ENTITY_LABELS: Record<ActivityEntity, string> = {
  customer: "Customer",
  opportunity: "Opportunity",
  task: "Task",
  quote: "Quote",
};

/** Only records of the active workspace are ever linked (the API resolved each one inside it). Tasks open from the task list. */
export function entityHref(type: ActivityEntity, id: string): string | null {
  if (type === "customer") return `/app/customers/${id}`;
  if (type === "opportunity") return `/app/opportunities/${id}`;
  if (type === "task") return "/app/tasks";
  return null;
}

type Props = {
  items: TimelineItem[];
  timeZone: string;
  /** For the heading-less list's accessible name, for example "Activity". */
  label: string;
  /** Injected clock for tests; defaults to the current time. */
  now?: Date;
};

/**
 * The one activity timeline (dashboard, activity page, customer page): a semantic ordered list, newest first as given.
 * Each item shows what happened (icon + word), the plain-text summary (a link to the record when it exists, with archived
 * records marked), who did it, and when: relative words in a `<time>` with the exact instant, plus the full local timestamp
 * for assistive tech. Changed fields list old and new values of whitelisted fields, and only the NAME of a free-text field
 * that changed. Everything is rendered as text.
 */
export function ActivityTimeline({ items, timeZone, label, now = new Date() }: Props) {
  const full = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
  return (
    <ol
      aria-label={label}
      className="flex flex-col divide-y divide-border rounded-lg border border-border"
    >
      {items.map((e) => {
        const { label: actionLabel, Icon } = ACTIONS[e.action] ?? {
          label: e.action,
          Icon: History,
        };
        const href =
          e.entity && e.entity.state !== "missing" ? entityHref(e.entity.type, e.entity.id) : null;
        const when = new Date(e.createdAt);
        const fullText = full.format(when);
        const rel = relativeTime(e.createdAt, now);
        return (
          <li key={e.id} className="flex gap-3 px-3 py-3 text-sm">
            <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p>
                <span className="font-medium">{actionLabel}</span>
                {e.entity ? (
                  <span className="text-muted-foreground"> · {ENTITY_LABELS[e.entity.type]}</span>
                ) : null}
                {e.entity?.state === "archived" ? (
                  <span className="ml-2 rounded-md border border-border px-1.5 py-0.5 text-xs">
                    Archived
                  </span>
                ) : null}
              </p>
              <p>
                {href ? (
                  <Link href={href} className="touch-link underline-offset-4 hover:underline">
                    {e.summary}
                  </Link>
                ) : (
                  e.summary
                )}
              </p>
              <p className="text-muted-foreground">
                By {e.actorName} ·{" "}
                <time dateTime={e.createdAt} title={fullText}>
                  {rel ?? fullText}
                </time>
                {rel ? <span className="sr-only"> ({fullText})</span> : null}
              </p>
              {e.changes.length > 0 || e.contentChanged.length > 0 ? (
                <ul className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
                  {e.changes.map((c) => (
                    <li key={c.field}>
                      {FIELD_LABELS[c.field] ?? c.field}: {showChange(c.field, c.old)} to{" "}
                      {showChange(c.field, c.new)}
                    </li>
                  ))}
                  {e.contentChanged.map((field) => (
                    <li key={field}>{FIELD_LABELS[field] ?? field} was edited</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
