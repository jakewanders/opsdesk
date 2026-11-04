"use client";

import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { notify } from "@/components/shared/toast";
import { clearFresh, markFresh } from "@/lib/motion/fresh";
import { isClientApiError, type ApiResponse } from "@/lib/api-client/api-fetch";
import { useApi, useScopedKey } from "@/lib/api-client/provider";
import type { Stage } from "@/lib/domain/pipeline";
import type { ApiMeta } from "@/lib/api/types";
import { movedDeal, totalsAfterMove, type PipelineTotals } from "./pipeline-model";
import type { OpportunityDto } from "./schema";

/** Board queries live under one prefix: `["opportunities-board", "summary" | "column", ...]`. */
export const BOARD_KEY = ["opportunities-board"] as const;

export type Move = { deal: OpportunityDto; to: Stage; lostReason?: string | null };
type Cached = ApiResponse<OpportunityDto[]> | undefined;
type Snapshot = Array<[QueryKey, unknown]>;

/**
 * Moves a deal to another stage through POST /opportunities/:id/stage. The card moves at once (its column, its stage,
 * its probability) and the page totals change by the same amounts the server will compute; on ANY error every board
 * query is put back exactly as it was and the person is told why, then the board is refetched so the server has the last
 * word. A 409 (someone else changed the deal), 422 (a lost reason is missing) and 403 (no permission) each get their own
 * message.
 */
export function useMoveStage() {
  const { fetch: call } = useApi();
  const queryClient = useQueryClient();
  const prefix = useScopedKey([...BOARD_KEY]);
  const dashboardPrefix = useScopedKey(["dashboard"]);

  return useMutation<ApiResponse<OpportunityDto>, Error, Move, { snapshot: Snapshot }>({
    mutationFn: ({ deal, to, lostReason }) =>
      call<OpportunityDto>(`/opportunities/${deal.id}/stage`, {
        method: "POST",
        json: { stage: to, lostReason: lostReason ?? null, expectedUpdatedAt: deal.updatedAt },
      }),
    onMutate: async ({ deal, to, lostReason }) => {
      await queryClient.cancelQueries({ queryKey: prefix });
      const snapshot = queryClient.getQueriesData({ queryKey: prefix }) as Snapshot;
      markFresh(deal.id); // the card is in its new column now: settle there, on the drop
      const moved = movedDeal(deal, to, { lostReason, now: new Date() });
      for (const [key, data] of snapshot) {
        const kind = key[2];
        const cached = data as Cached;
        if (!cached) continue;
        if (kind === "summary") {
          const meta = cached.meta as ApiMeta & Partial<PipelineTotals>;
          if (!meta.stageTotals) continue;
          const next = totalsAfterMove(meta as PipelineTotals, deal, to);
          queryClient.setQueryData(key, { ...cached, meta: { ...cached.meta, ...next } });
        } else if (kind === "column") {
          const stage = key[3] as Stage;
          if (stage === deal.stage) {
            queryClient.setQueryData(key, {
              ...cached,
              data: cached.data.filter((d) => d.id !== deal.id),
            });
          } else if (stage === to) {
            queryClient.setQueryData(key, { ...cached, data: [moved, ...cached.data] });
          }
        }
      }
      return { snapshot };
    },
    onError: (error, { deal }, context) => {
      clearFresh(deal.id);
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);
      if (!isClientApiError(error)) {
        notify.error("The deal was not moved", "Something went wrong. Try again.");
      } else if (error.isStaleEdit) {
        notify.error(
          "The deal was not moved",
          "Someone else changed it. The board has been refreshed.",
        );
      } else if (error.status === 429) {
        notify.error(
          "The deal was not moved",
          "You are making changes too quickly. Wait a moment, then try again.",
        );
      } else if (error.status === 403) {
        notify.error(
          "The deal was not moved",
          "You do not have permission to move deals in this workspace.",
        );
      } else {
        notify.error("The deal was not moved", error.message);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: prefix });
      // the dashboard's pipeline numbers follow the deal
      void queryClient.invalidateQueries({ queryKey: dashboardPrefix });
    },
  });
}
