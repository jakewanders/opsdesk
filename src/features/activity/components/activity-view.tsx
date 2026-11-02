"use client";

import { Activity as ActivityIcon, Search } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MemberDto } from "@/features/members/service";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiQuery } from "@/lib/api-client/provider";
import { useUrlState } from "@/lib/api-client/use-url-state";
import { ACTIVITY_ACTIONS, ACTIVITY_ENTITY_TYPES } from "../schema";
import { activityPageUrl, hasActiveFilters, PAGE_SIZES, toActivityQuery } from "../filter-state";
import type { ActivityItemDto } from "../service";
import { ActivityTimeline } from "./activity-timeline";

const SELECT =
  "h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring";
const ENTITY_LABELS: Record<string, string> = {
  customer: "Customers",
  opportunity: "Opportunities",
  task: "Tasks",
  quote: "Quotes",
};
const ACTION_LABELS: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  archived: "Archived",
  restored: "Restored",
  deleted: "Deleted",
  stage_changed: "Stage changed",
  completed: "Completed",
  reopened: "Reopened",
  sent: "Sent",
  approved: "Approved",
  rejected: "Rejected",
  imported: "Imported",
};

type Props = { currentUserId: string; timeZone: string };

/**
 * /app/activity: the workspace's change history, newest first, 25 to a page. Filters (record kind, action, person, date
 * range in the workspace's time zone) and the page number live in the URL, so a filtered view can be shared and survives a
 * reload. The feed is answered by `GET /api/v1/activity`; this component only asks and shows.
 */
export function ActivityView({ currentUserId, timeZone }: Props) {
  const [state, setState] = useUrlState(activityPageUrl);
  const apiQuery = toActivityQuery(state);
  const query = useApiQuery<ActivityItemDto[]>(["activity", apiQuery], "/activity", {
    query: apiQuery,
    keepPrevious: true,
  });
  const members = useApiQuery<MemberDto[]>(["members"], "/members");
  const items = query.data?.data ?? [];
  const total = Number(query.data?.meta.total ?? 0);
  const totalPages = Number(query.data?.meta.totalPages ?? 0);
  const filtered = hasActiveFilters(state);
  const pastTheEnd = items.length === 0 && total > 0;
  const from = total === 0 ? 0 : (state.page - 1) * state.limit + 1;
  const to = Math.min(total, (state.page - 1) * state.limit + items.length);
  const clear = () => setState({ entityType: "", action: "", actor: "", from: "", to: "" });

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-sm text-muted-foreground">
          Everything that changed in this workspace, newest first.
        </p>
      </header>

      <form
        role="search"
        aria-label="Filter activity"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-1 text-sm font-medium">
          <label htmlFor="act-entity">Records</label>
          <select
            id="act-entity"
            className={SELECT}
            value={state.entityType}
            onChange={(e) => setState({ entityType: e.target.value })}
          >
            <option value="">All records</option>
            {ACTIVITY_ENTITY_TYPES.filter((t) => t !== "quote").map((t) => (
              <option key={t} value={t}>
                {ENTITY_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium">
          <label htmlFor="act-action">What happened</label>
          <select
            id="act-action"
            className={SELECT}
            value={state.action}
            onChange={(e) => setState({ action: e.target.value })}
          >
            <option value="">Anything</option>
            {ACTIVITY_ACTIONS.filter((a) =>
              [
                "created",
                "updated",
                "archived",
                "restored",
                "stage_changed",
                "completed",
                "reopened",
              ].includes(a),
            ).map((a) => (
              <option key={a} value={a}>
                {ACTION_LABELS[a]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium">
          <label htmlFor="act-actor">Who</label>
          <select
            id="act-actor"
            className={SELECT}
            value={state.actor}
            onChange={(e) => setState({ actor: e.target.value })}
          >
            <option value="">Anyone</option>
            <option value="system">System</option>
            {(members.data?.data ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName}
                {m.userId === currentUserId ? " (you)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium">
          <label htmlFor="act-from">From</label>
          <Input
            id="act-from"
            type="date"
            value={state.from}
            onChange={(e) => setState({ from: e.target.value })}
            className="w-40"
          />
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium">
          <label htmlFor="act-to">To</label>
          <Input
            id="act-to"
            type="date"
            value={state.to}
            onChange={(e) => setState({ to: e.target.value })}
            className="w-40"
          />
        </div>
        {filtered ? (
          <Button type="button" variant="ghost" onClick={clear}>
            Clear filters
          </Button>
        ) : null}
      </form>

      {query.isError ? (
        <ErrorAlert
          title="Activity could not be loaded"
          message={
            isClientApiError(query.error) ? query.error.message : "Something went wrong. Try again."
          }
          requestId={isClientApiError(query.error) ? query.error.requestId : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {query.isPending ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading activity</span>
          <div aria-hidden="true" className="flex flex-col gap-2">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        </div>
      ) : query.data && total === 0 && !filtered ? (
        <EmptyState
          icon={<ActivityIcon />}
          title="No activity yet"
          description="Changes to customers, opportunities and tasks appear here as they happen."
        />
      ) : query.data && (total === 0 || pastTheEnd) ? (
        <EmptyState
          icon={<Search />}
          title={pastTheEnd ? "There is no activity on this page" : "No activity matches"}
          description={
            pastTheEnd
              ? "The feed has fewer pages than that."
              : "Nothing matches these filters. Widen the dates or clear the filters."
          }
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => (pastTheEnd ? setState({ page: 1 }) : clear())}
            >
              {pastTheEnd ? "Go to the first page" : "Clear filters"}
            </Button>
          }
        />
      ) : query.data ? (
        <>
          <div
            aria-busy={query.isFetching}
            className={query.isPlaceholderData ? "opacity-60" : undefined}
          >
            <ActivityTimeline
              label="Activity"
              timeZone={timeZone}
              items={items.map((e) => ({
                id: e.id,
                action: e.action,
                summary: e.summary,
                actorName: e.actorUserId === currentUserId ? "You" : e.actorName,
                createdAt: e.createdAt,
                changes: e.changes,
                contentChanged: e.contentChanged,
                entity: { type: e.entityType, id: e.entityId, state: e.entityState },
              }))}
            />
          </div>
          <nav
            aria-label="Pagination"
            className="flex flex-wrap items-center justify-between gap-3 text-sm"
          >
            <p aria-live="polite">
              Showing {from} to {to} of {total}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">
                Per page
                <select
                  className={SELECT}
                  value={state.limit}
                  onChange={(e) => setState({ limit: Number(e.target.value) })}
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={state.page <= 1}
                onClick={() => setState({ page: state.page - 1 })}
              >
                Previous page
              </Button>
              <span>
                Page {state.page} of {Math.max(totalPages, 1)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={state.page >= totalPages}
                onClick={() => setState({ page: state.page + 1 })}
              >
                Next page
              </Button>
            </div>
          </nav>
        </>
      ) : null}
    </div>
  );
}
