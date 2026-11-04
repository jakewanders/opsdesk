"use client";

import { Breadcrumbs } from "@/components/shared/breadcrumbs";
import { ListLink } from "@/components/shared/list-crumb";
import { Archive, ArchiveRestore, Building2, Pencil, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { notify } from "@/components/shared/toast";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ActivityEventDto } from "@/features/activity/repository";
import type { MemberDto } from "@/features/members/service";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiQuery } from "@/lib/api-client/provider";
import { useApiMutation } from "@/lib/api-client/use-api-mutation";
import { useState, type ReactNode } from "react";
import type { CustomerDetailDto } from "../schema";
import { ActivityTimeline } from "@/features/activity/components/activity-timeline";
import { ArchiveCustomerDialog } from "./archive-customer-dialog";
import { CustomerStatus } from "./customer-status";
import { RelatedOpportunities, RelatedTasks } from "./customer-related";
import { Morph } from "@/components/shared/morph";

type Props = {
  customer: CustomerDetailDto;
  events: ActivityEventDto[];
  /** Owner, admin and member may edit, archive and restore. */
  canWrite: boolean;
  currentUserId: string;
  /** The organization's time zone, for every time shown. */
  timeZone: string;
  /**
   * The Quotes tab, supplied only when the quotes feature flag is on AND the quotes API exists (`quotesTabEnabled`). With no
   * value no Quotes tab is rendered: there is never an empty placeholder tab.
   */
  quotesTab?: { count: number; content: ReactNode };
};

const SOURCE_LABELS = {
  referral: "Referral",
  website: "Website",
  outbound: "Outbound",
  other: "Other",
} as const;
/**
 * One customer: header (name, company, status as icon + word, owner, tags, times, actions), an Overview tab and an Activity
 * tab. Notes and every value from an event are rendered as text. An archived customer says so and offers Restore to people
 * who can write; archive and restore go through the API and then refresh the page's server data and the customer list.
 */
export function CustomerDetail({
  customer,
  events,
  canWrite,
  currentUserId,
  timeZone,
  quotesTab,
}: Props) {
  const router = useRouter();
  const members = useApiQuery<MemberDto[]>(["members"], "/members");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const nameOf = (id: string | null) =>
    id === null
      ? null
      : id === currentUserId
        ? "You"
        : (members.data?.data.find((m) => m.userId === id)?.displayName ?? "A teammate");

  const when = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
  const stamp = (iso: string) => (
    <time dateTime={iso} title={new Date(iso).toISOString()}>
      {when.format(new Date(iso))}
    </time>
  );

  const restore = useApiMutation<unknown, void>({
    mutationFn: (_v, { call }) => call(`/customers/${customer.id}/restore`, { method: "POST" }),
    invalidate: [["customers"], ["dashboard"]],
  });
  const restoreNow = async () => {
    setProblem(null);
    try {
      await restore.mutateAsync();
      notify.success("Customer restored", customer.displayName);
      router.refresh();
    } catch (error) {
      setProblem(
        isClientApiError(error)
          ? `${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`
          : "The customer was not restored. Try again.",
      );
    }
  };

  const archived = customer.archivedAt !== null;
  const owner =
    customer.assignedTo === null ? "Unassigned" : (nameOf(customer.assignedTo) ?? "Unassigned");

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <Breadcrumbs
        items={[
          { label: "Customers", node: <ListLink list="customers">Customers</ListLink> },
          { label: customer.displayName },
        ]}
      />
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {customer.type === "company" ? (
            <Building2 aria-hidden="true" className="size-6 text-muted-foreground" />
          ) : (
            <User aria-hidden="true" className="size-6 text-muted-foreground" />
          )}
          <Morph entity="customer" id={customer.id}>
            <h1 className="text-2xl font-semibold tracking-tight">
              {customer.displayName}
              <span className="sr-only">
                {" "}
                ({customer.type === "company" ? "company" : "person"})
              </span>
            </h1>
          </Morph>
          <CustomerStatus status={customer.status} />
          {archived ? (
            <span className="rounded-md border border-border px-2 py-0.5 text-sm font-medium">
              Archived
            </span>
          ) : null}
        </div>
        {customer.companyName ? (
          <p className="text-muted-foreground">{customer.companyName}</p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Owner: <span className="font-medium text-foreground">{owner}</span>
        </p>
        {customer.tags.length > 0 ? (
          <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
            {customer.tags.map((tag) => (
              <li
                key={tag}
                className="rounded-md border border-border bg-muted px-2 py-0.5 text-sm"
              >
                {tag}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Created {stamp(customer.createdAt)} · Updated {stamp(customer.updatedAt)}
        </p>
        <div className="flex flex-wrap gap-2">
          {canWrite && !archived ? (
            <Link href={`/app/customers/${customer.id}/edit`} className={buttonVariants()}>
              <Pencil aria-hidden="true" />
              Edit
            </Link>
          ) : null}
          {canWrite && !archived ? (
            <Button type="button" variant="outline" onClick={() => setConfirmArchive(true)}>
              <Archive aria-hidden="true" />
              Archive
            </Button>
          ) : null}
          {!canWrite && !archived ? (
            <Button type="button" variant="outline" disabled aria-describedby="archive-note">
              <Archive aria-hidden="true" />
              Archive
            </Button>
          ) : null}
          {canWrite && archived ? (
            <Button type="button" onClick={() => void restoreNow()} pending={restore.isPending}>
              <ArchiveRestore aria-hidden="true" />
              Restore
            </Button>
          ) : null}
          <ListLink list="customers" className={buttonVariants({ variant: "outline" })}>
            Back to customers
          </ListLink>
        </div>
        {!canWrite && !archived ? (
          <p id="archive-note" className="text-sm text-muted-foreground">
            You can view this customer but not archive it. Ask an owner or admin for edit access.
          </p>
        ) : null}
        {archived ? (
          <div role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">
            <p className="font-medium">This customer is archived.</p>
            <p className="text-muted-foreground">
              It is hidden from the customer list. Its opportunities and history are kept
              {canWrite ? ", and you can restore it." : "."}
            </p>
          </div>
        ) : null}
        {problem ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive-subtle p-3 text-sm"
          >
            {problem}
          </div>
        ) : null}
      </header>

      <Tabs defaultValue="overview">
        <TabsList
          variant="line"
          aria-label="Customer sections"
          className="w-full max-w-full justify-start overflow-x-auto"
        >
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="opportunities">
            Opportunities ({customer.related.opportunities})
          </TabsTrigger>
          <TabsTrigger value="tasks">Tasks ({customer.related.tasks})</TabsTrigger>
          {quotesTab ? <TabsTrigger value="quotes">Quotes ({quotesTab.count})</TabsTrigger> : null}
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 rounded-lg border border-border p-4 text-sm sm:grid-cols-2">
            <Item label="Email" value={customer.email} />
            <Item label="Phone" value={customer.phone} />
            <div>
              <dt className="text-muted-foreground">Website</dt>
              <dd className="font-medium">
                {customer.website ? (
                  <a
                    href={customer.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                  >
                    {customer.website}
                  </a>
                ) : (
                  <span className="text-muted-foreground">Not set</span>
                )}
              </dd>
            </div>
            <Item label="Source" value={SOURCE_LABELS[customer.source]} />
            <Item label="Opportunities" value={String(customer.related.opportunities)} />
            <Item label="Tasks" value={String(customer.related.tasks)} />
          </dl>
          <section aria-labelledby="notes-heading" className="mt-4 text-sm">
            <h2 id="notes-heading" className="font-semibold">
              Notes
            </h2>
            {/* rendered as text, never as markup */}
            <p className="mt-1 whitespace-pre-wrap">
              {customer.notes ?? <span className="text-muted-foreground">No notes.</span>}
            </p>
          </section>
        </TabsContent>

        <TabsContent value="opportunities" className="mt-4">
          <RelatedOpportunities customer={customer} canWrite={canWrite} archived={archived} />
        </TabsContent>

        <TabsContent value="tasks" className="mt-4">
          <RelatedTasks
            customer={customer}
            canWrite={canWrite}
            archived={archived}
            currentUserId={currentUserId}
            timeZone={timeZone}
          />
        </TabsContent>

        {quotesTab ? (
          <TabsContent value="quotes" className="mt-4">
            {quotesTab.content}
          </TabsContent>
        ) : null}

        <TabsContent value="activity" className="mt-4">
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No activity has been recorded for this customer yet.
            </p>
          ) : (
            <ActivityTimeline
              label="Activity"
              timeZone={timeZone}
              items={events.map((event) => ({
                id: event.id,
                action: event.action,
                summary: event.summary,
                actorName:
                  event.actorUserId === null
                    ? "System"
                    : (nameOf(event.actorUserId) ?? "A teammate"),
                createdAt: event.createdAt,
                changes: event.changes,
                contentChanged: event.contentChanged,
              }))}
            />
          )}
        </TabsContent>
      </Tabs>

      <ArchiveCustomerDialog
        customer={confirmArchive ? { id: customer.id, displayName: customer.displayName } : null}
        onClose={() => setConfirmArchive(false)}
        onArchived={() => router.refresh()}
      />
    </div>
  );
}

function Item({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">
        {value ?? <span className="text-muted-foreground">Not set</span>}
      </dd>
    </div>
  );
}
