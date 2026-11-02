"use client";

import Link from "next/link";
import type { RecentActivityDto } from "@/features/activity/repository";
import type { MemberDto } from "@/features/members/service";
import { useApiQuery } from "@/lib/api-client/provider";

type Props = { events: RecentActivityDto[]; currentUserId: string; timeZone: string };

/** Where a record lives. Tasks open from the task list; quotes have no page yet, so those events are plain text. */
function entityHref(e: RecentActivityDto): string | null {
  switch (e.entityType) {
    case "customer":
      return `/app/customers/${e.entityId}`;
    case "opportunity":
      return `/app/opportunities/${e.entityId}`;
    case "task":
      return "/app/tasks";
    default:
      return null;
  }
}

/** The newest events of the workspace: who, what, when (with the full timestamp), and a link to the record. */
export function RecentActivity({ events, currentUserId, timeZone }: Props) {
  const members = useApiQuery<MemberDto[]>(["members"], "/members");
  const when = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
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
        <Link href="/app/activity" className="text-sm underline-offset-4 hover:underline">
          View all<span className="sr-only"> activity</span>
        </Link>
      </div>
      {events.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          Nothing has happened in this workspace yet. Changes to customers, deals and tasks appear
          here.
        </p>
      ) : (
        <ol className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {events.map((e) => {
            const href = entityHref(e);
            return (
              <li key={e.id} className="flex flex-col gap-0.5 px-3 py-2 text-sm">
                <p>
                  {href ? (
                    <Link href={href} className="underline-offset-4 hover:underline">
                      {e.summary}
                    </Link>
                  ) : (
                    e.summary
                  )}
                </p>
                <p className="text-muted-foreground">
                  By {actor(e)} ·{" "}
                  <time dateTime={e.createdAt} title={new Date(e.createdAt).toISOString()}>
                    {when.format(new Date(e.createdAt))}
                  </time>
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
