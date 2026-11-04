"use client";

import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { notify } from "@/components/shared/toast";
import { markFresh } from "@/lib/motion/fresh";
import { isClientApiError, type ApiResponse } from "@/lib/api-client/api-fetch";
import { useApi, useScopedKey } from "@/lib/api-client/provider";
import type { TaskDto } from "./schema";
import { applyTaskChange, toggledTask } from "./task-cache";

export type Toggle = { task: TaskDto; completed: boolean };
type Snapshot = Array<[QueryKey, unknown]>;

/**
 * Completes or reopens a task through POST /tasks/:id/complete with the version the row was loaded with. The row changes at
 * once (and leaves the list it no longer belongs to, with the totals lowered); on ANY error every task list is put back
 * exactly as it was, the person is told why (a 409 says someone else changed it and the list is refreshed), and the lists
 * are refetched. Dashboard queries are refetched when the write settles.
 */
export function useCompleteTask(timeZone: string) {
  const { fetch: call } = useApi();
  const queryClient = useQueryClient();
  const tasksPrefix = useScopedKey(["tasks"]);
  const dashboardPrefix = useScopedKey(["dashboard"]);

  const mutation = useMutation<ApiResponse<TaskDto>, Error, Toggle, { snapshot: Snapshot }>({
    mutationFn: ({ task, completed }) =>
      call<TaskDto>(`/tasks/${task.id}/complete`, {
        method: "POST",
        json: { completed, expectedUpdatedAt: task.updatedAt },
      }),
    onMutate: async ({ task, completed }) => {
      await queryClient.cancelQueries({ queryKey: tasksPrefix });
      const snapshot = queryClient.getQueriesData({ queryKey: tasksPrefix }) as Snapshot;
      const next = toggledTask(task, completed, { now: new Date(), timeZone });
      for (const [key, data] of snapshot) {
        const cached = data as ApiResponse<TaskDto[]> | undefined;
        if (!cached || !Array.isArray(cached.data)) continue;
        queryClient.setQueryData(
          key,
          applyTaskChange(cached, key[2] as Record<string, unknown> | undefined, next),
        );
      }
      return { snapshot };
    },
    onError: (error, { completed }, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);
      const what = completed ? "The task was not completed" : "The task was not reopened";
      if (isClientApiError(error) && error.isStaleEdit) {
        notify.error(what, "Someone else changed it. The list has been refreshed.");
      } else if (isClientApiError(error) && error.status === 403) {
        notify.error(what, "You do not have permission to change tasks in this workspace.");
      } else {
        notify.error(
          what,
          isClientApiError(error) ? error.message : "Something went wrong. Try again.",
        );
      }
    },
    onSuccess: (res, { task, completed }) => {
      if (completed) {
        // Undo reopens with the version the server just returned.
        notify.success("Task completed", task.title, {
          label: "Undo",
          onClick: () => mutation.mutate({ task: res.data, completed: false }),
        });
      } else {
        markFresh(task.id);
        notify.success("Task reopened", task.title);
      }
    },
    // The refetch runs in the background: the mutation (and the row's button) is settled as soon as the API has answered.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: tasksPrefix });
      void queryClient.invalidateQueries({ queryKey: dashboardPrefix });
    },
  });
  return mutation;
}
