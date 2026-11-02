import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarClock,
  CircleCheck,
  CircleDot,
  CircleDashed,
  OctagonAlert,
} from "lucide-react";
import type { TaskDto } from "../schema";

export const STATUS_LABELS = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
} as const;
export const PRIORITY_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
} as const;

const STATUS_ICON = {
  todo: CircleDashed,
  in_progress: CircleDot,
  blocked: OctagonAlert,
  done: CircleCheck,
} as const;

/** Status as an icon AND a word, never colour alone. */
export function TaskStatus({ status }: { status: TaskDto["status"] }) {
  const Icon = STATUS_ICON[status];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      {STATUS_LABELS[status]}
    </span>
  );
}

const PRIORITY_ICON = {
  low: ArrowDown,
  medium: ArrowUpDown,
  high: ArrowUp,
  urgent: AlertTriangle,
} as const;

export function TaskPriority({ priority }: { priority: TaskDto["priority"] }) {
  const Icon = PRIORITY_ICON[priority];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const FULL_DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: "UTC" });

/**
 * The due date with its state, from the API's own flags (the shared overdue rule, evaluated in the organization's time
 * zone on the server): "Overdue" and "Due today" are different words with different icons, so neither relies on colour.
 */
export function DueDate({ task }: { task: Pick<TaskDto, "dueDate" | "dueState" | "dueToday"> }) {
  if (!task.dueDate) return <span className="text-muted-foreground">No due date</span>;
  const at = new Date(`${task.dueDate}T00:00:00Z`);
  return (
    <span className="inline-flex flex-col">
      <time dateTime={task.dueDate} title={FULL_DATE.format(at)} className="whitespace-nowrap">
        {day.format(at)}
      </time>
      {task.dueState === "overdue" ? (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-destructive">
          <AlertTriangle aria-hidden="true" className="size-3.5" />
          Overdue
        </span>
      ) : task.dueToday ? (
        <span className="inline-flex items-center gap-1 text-xs font-semibold">
          <CalendarClock aria-hidden="true" className="size-3.5" />
          Due today
        </span>
      ) : null}
    </span>
  );
}
