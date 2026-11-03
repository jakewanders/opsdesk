"use client";

import { TableSkeleton } from "@/components/shared/skeletons";
import { useUrlState } from "@/lib/api-client/use-url-state";
import { useRememberList } from "@/lib/api-client/use-remember-list";
import { useViewport } from "@/lib/use-viewport";
import { effectiveView, opportunityPageUrl } from "../filter-state";
import { OpportunityList } from "./opportunity-list";
import { PipelineBoard } from "./pipeline-board";

type Props = { canWrite: boolean; currentUserId: string };

/**
 * /app/opportunities: the board or the list, chosen by `?view=board|list`. With no choice in the URL a wide screen gets the
 * board and a narrow one (under 768px) gets the list. Until the screen width is known nothing is fetched, so the wrong view
 * is never loaded first.
 */
export function OpportunitiesView({ canWrite, currentUserId }: Props) {
  const [state] = useUrlState(opportunityPageUrl);
  useRememberList("opportunities");
  const viewport = useViewport();
  if (state.view === "" && viewport === "pending")
    return <TableSkeleton label="Loading the pipeline" columns={6} rows={6} />;
  const view = effectiveView(state, viewport === "mobile" ? "mobile" : "desktop");
  return view === "list" ? (
    <OpportunityList canWrite={canWrite} currentUserId={currentUserId} />
  ) : (
    <PipelineBoard canWrite={canWrite} currentUserId={currentUserId} />
  );
}
