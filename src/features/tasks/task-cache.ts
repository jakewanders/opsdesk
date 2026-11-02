import type { ApiResponse } from "@/lib/api-client/api-fetch";
import { dueState, todayInZone } from "@/lib/domain/tasks";
import type { TaskDto } from "./schema";

/**
 * What a task becomes when it is completed or reopened, for the optimistic update only. The server's answer replaces it.
 * Completing: status `done`, a completion time, and no overdue / due-today marks. Reopening: back to `todo` (or the chosen
 * status), no completion time, and the due marks from the SHARED rules for the organization's zone (not an ad hoc client rule).
 */
export function toggledTask(
  task: TaskDto,
  completed: boolean,
  options: { now: Date; timeZone: string; reopenStatus?: TaskDto["status"] },
): TaskDto {
  if (completed) {
    return {
      ...task,
      status: "done",
      completedAt: options.now.toISOString(),
      dueState: "done",
      dueToday: false,
    };
  }
  const status =
    options.reopenStatus && options.reopenStatus !== "done" ? options.reopenStatus : "todo";
  return {
    ...task,
    status,
    completedAt: null,
    dueState: dueState({ dueDate: task.dueDate, status }, options.now, options.timeZone),
    dueToday: task.dueDate !== null && task.dueDate === todayInZone(options.now, options.timeZone),
  };
}

type Params = Record<string, unknown> | undefined;
type Cached = ApiResponse<TaskDto[]>;

/** Would `task` still be listed by a list query with these parameters (only the filters a status change can affect)? */
function stillListed(task: TaskDto, params: Params): boolean {
  if (params?.status && params.status !== task.status) return false;
  if (params?.overdue === "true" && task.dueState !== "overdue") return false;
  return true;
}

/**
 * One cached task list after a task changed: the row is updated in place, or removed (and the total and page count lowered)
 * when the change takes it out of what that list shows, for example completing a task in the Overdue view. Lists that do not
 * contain the task are returned untouched.
 */
export function applyTaskChange(cached: Cached, params: Params, next: TaskDto): Cached {
  const index = cached.data.findIndex((t) => t.id === next.id);
  if (index === -1) return cached;
  if (stillListed(next, params)) {
    return { ...cached, data: cached.data.map((t) => (t.id === next.id ? next : t)) };
  }
  const total = Math.max(0, Number(cached.meta.total ?? cached.data.length) - 1);
  const limit = Number(cached.meta.limit ?? 25) || 25;
  return {
    ...cached,
    data: cached.data.filter((t) => t.id !== next.id),
    meta: { ...cached.meta, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}
