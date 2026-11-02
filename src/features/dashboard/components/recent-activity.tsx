"use client";

import Link from "next/link";
import { ActivityTimeline } from "@/features/activity/components/activity-timeline";
import type { RecentActivityDto } from "@/features/activity/repository";
import type { MemberDto } from "@/features/members/service";
import { useApiQuery } from "@/lib/api-client/provider";

type Props = { events: RecentActivityDto[]; currentUserId: string; timeZone: string };

/** The newest events of the workspace: who, what, when (with the full timestamp), and a link to the record. */
export function RecentActivity({ events, currentUserId, timeZone }: Props) {
  const members = useApiQuery<MemberDto[]>(["members"], "/members");
  const actor = (e: RecentActivityDto) =>
    e.actorUserId === null
      ? "System"
      : e.actorUserId === currentUserId
        ? "You"
        : (members.data?.data.find((m) => m.userId === e.actorUserId)?.displayName ??
          (members.isPending ? "A teammate" : "Former member"));

  return (
    <section aria-labelledby="dash-activity" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="dash-activity" className="text-lg font-semibold">
          Recent activity
        </h2>
        <Link
          href="/app/activity"
          className="touch-link text-sm underline-offset-4 hover:underline"
        >
          View all<span className="sr-only"> activity</span>
        </Link>
      </div>
      {events.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          Nothing has happened in this workspace yet. Changes to customers, deals and tasks appear
          here.
        </p>
      ) : (
        <ActivityTimeline
          label="Recent activity"
          timeZone={timeZone}
          items={events.map((e) => ({
            id: e.id,
            action: e.action,
            summary: e.summary,
            actorName: actor(e),
            createdAt: e.createdAt,
            changes: [],
            contentChanged: [],
            // the dashboard payload does not say whether a record was archived, so it links like an active one
            entity: { type: e.entityType, id: e.entityId, state: "active" },
          }))}
        />
      )}
    </section>
  );
}
