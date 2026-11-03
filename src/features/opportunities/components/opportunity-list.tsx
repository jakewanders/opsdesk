"use client";

import { ArchivedBadge } from "@/components/shared/archived-badge";
import { ScopeNote } from "@/components/shared/scope-note";
import { CopyLinkButton } from "@/components/shared/copy-link-button";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Plus, Search, Target } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorAlert } from "@/components/shared/error-alert";
import { TableSkeleton } from "@/components/shared/skeletons";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MemberDto } from "@/features/members/service";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiQuery } from "@/lib/api-client/provider";
import { useDebouncedUrlParam, useUrlState } from "@/lib/api-client/use-url-state";
import { STAGES, STAGE_LABELS, type StageTotals } from "@/lib/domain/pipeline";
import { formatUsd } from "@/lib/money/format";
import { cn } from "@/lib/utils";
import {
  hasActiveFilters,
  opportunityPageUrl,
  PAGE_SIZES,
  toListQuery,
  type OpportunityPageState,
} from "../filter-state";
import type { OpportunityDto } from "../schema";
import { StageLabel } from "./stage-badge";
import { ViewToggle } from "./view-toggle";

type Props = { canWrite: boolean; currentUserId: string };
type SortKey = OpportunityPageState["sort"];

const SELECT =
  "h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring";
const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const formatDay = (value: string) => day.format(new Date(`${value}T00:00:00Z`));
const columnHelper = createColumnHelper<OpportunityDto>();

function SortHeader({
  label,
  sortKey,
  state,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  state: OpportunityPageState;
  onSort: (key: SortKey) => void;
}) {
  const active = state.sort === sortKey;
  const Icon = !active ? ArrowUpDown : state.order === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className="-mx-2 inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring"
    >
      {label}
      <Icon aria-hidden="true" className={cn("size-3.5", !active && "text-muted-foreground")} />
      <span className="sr-only">
        {active ? `, sorted ${state.order === "asc" ? "ascending" : "descending"}` : ", sort"}
      </span>
    </button>
  );
}

/**
 * The opportunity list (PRD 9.4): search, stage, owner and expected-close-date filters, sorting and paging all live in the
 * URL and are answered by the API. The strip above the table shows the count and total per stage for the WHOLE filtered
 * set from the API's `meta` (the domain module's numbers), never recomputed here. Money goes through `formatUsd` only.
 */
export function OpportunityList({ canWrite, currentUserId }: Props) {
  const [state, setState] = useUrlState(opportunityPageUrl);
  const [search, onSearch] = useDebouncedUrlParam(state.q, (q) => setState({ q }));
  const apiQuery = toListQuery(state);
  const query = useApiQuery<OpportunityDto[]>(["opportunities-list", apiQuery], "/opportunities", {
    query: apiQuery,
    keepPrevious: true,
  });
  const members = useApiQuery<MemberDto[]>(["members"], "/members");
  const ownerName = (id: string | null) =>
    id === null
      ? "Unassigned"
      : id === currentUserId
        ? "You"
        : (members.data?.data.find((m) => m.userId === id)?.displayName ?? "Teammate");

  const items = useMemo(() => query.data?.data ?? [], [query.data]);
  const meta = query.data?.meta as
    (Record<string, unknown> & { stageTotals?: StageTotals }) | undefined;
  const total = Number(meta?.total ?? 0);
  const totalPages = Number(meta?.totalPages ?? 0);
  const filtered = hasActiveFilters(state);
  const pastTheEnd = items.length === 0 && total > 0;
  const from = total === 0 ? 0 : (state.page - 1) * state.limit + 1;
  const to = Math.min(total, (state.page - 1) * state.limit + items.length);
  const clear = () => setState({ q: "", stage: "", assignedTo: "", closeFrom: "", closeTo: "" });
  const onSort = (key: SortKey) =>
    setState(
      state.sort === key
        ? { order: state.order === "asc" ? "desc" : "asc" }
        : { sort: key, order: key === "title" || key === "stage" ? "asc" : "desc" },
    );

  const columns = useMemo(
    () => [
      columnHelper.accessor("title", {
        header: () => <SortHeader label="Title" sortKey="title" state={state} onSort={onSort} />,
        cell: ({ row }) => (
          <Link
            href={`/app/opportunities/${row.original.id}`}
            className="font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring after:absolute after:inset-0"
          >
            {row.original.title}
          </Link>
        ),
      }),
      columnHelper.accessor("customerName", {
        header: "Customer",
        cell: ({ row }) => (
          <Link
            href={`/app/customers/${row.original.customerId}`}
            className="relative z-10 underline-offset-4 hover:underline"
          >
            {row.original.customerName ?? "Customer"}
            {row.original.customerArchived ? <ArchivedBadge /> : null}
          </Link>
        ),
      }),
      columnHelper.accessor("stage", {
        header: () => <SortHeader label="Stage" sortKey="stage" state={state} onSort={onSort} />,
        cell: (c) => <StageLabel stage={c.getValue()} />,
      }),
      columnHelper.accessor("amountCents", {
        header: () => (
          <SortHeader label="Amount" sortKey="amount_cents" state={state} onSort={onSort} />
        ),
        cell: (c) => <span className="tabular-nums">{formatUsd(c.getValue())}</span>,
      }),
      columnHelper.accessor("probabilityPercent", {
        header: "Probability",
        cell: (c) => <span className="tabular-nums">{c.getValue()}%</span>,
      }),
      columnHelper.accessor("assignedTo", {
        header: "Owner",
        cell: (c) => ownerName(c.getValue()),
      }),
      columnHelper.accessor("expectedCloseDate", {
        header: () => (
          <SortHeader
            label="Expected close"
            sortKey="expected_close_date"
            state={state}
            onSort={onSort}
          />
        ),
        cell: (c) =>
          c.getValue() ? (
            <time dateTime={c.getValue()!}>{formatDay(c.getValue()!)}</time>
          ) : (
            <span className="text-muted-foreground">Not set</span>
          ),
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSort and ownerName close over state and members, which are listed
    [state, members.data, currentUserId],
  );
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is opted out of memoization; nothing here is passed to memoized children
  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
  });
  const sortKeyOf: Record<string, SortKey> = {
    title: "title",
    stage: "stage",
    amountCents: "amount_cents",
    expectedCloseDate: "expected_close_date",
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
        <div className="flex flex-wrap items-center gap-2">
          <CopyLinkButton />
          <ViewToggle view="list" onChange={(view) => setState({ view })} />
          {canWrite ? (
            <Link href="/app/opportunities/new" className={buttonVariants()}>
              <Plus aria-hidden="true" />
              Add opportunity
            </Link>
          ) : null}
        </div>
      </header>

      <form
        role="search"
        aria-label="Filter opportunities"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="flex min-w-56 flex-1 flex-col gap-1 text-sm font-medium">
          <label htmlFor="opp-search">Search</label>
          <span className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="opp-search"
              type="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Deal or customer name"
              className="pl-8"
              autoComplete="off"
              maxLength={100}
            />
          </span>
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium">
          <label htmlFor="opp-stage">Stage</label>
          <select
            id="opp-stage"
            className={SELECT}
            value={state.stage}
            onChange={(e) => setState({ stage: e.target.value })}
          >
            <option value="">All stages</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium">
          <label htmlFor="opp-owner">Owner</label>
          <select
            id="opp-owner"
            className={SELECT}
            value={state.assignedTo}
            onChange={(e) => setState({ assignedTo: e.target.value })}
          >
            <option value="">All owners</option>
            {(members.data?.data ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName}
                {m.userId === currentUserId ? " (you)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium">
          <label htmlFor="opp-close-from">Closes from</label>
          <Input
            id="opp-close-from"
            type="date"
            value={state.closeFrom}
            onChange={(e) => setState({ closeFrom: e.target.value })}
            className="w-40"
          />
        </div>
        <div className="flex flex-col gap-1 text-sm font-medium">
          <label htmlFor="opp-close-to">Closes to</label>
          <Input
            id="opp-close-to"
            type="date"
            value={state.closeTo}
            onChange={(e) => setState({ closeTo: e.target.value })}
            className="w-40"
          />
        </div>
        {filtered ? (
          <Button type="button" variant="ghost" onClick={clear}>
            Clear filters
          </Button>
        ) : null}
      </form>
      {toListQuery(state).customerId ? (
        <ScopeNote
          text="Showing only deals for one customer."
          onClear={() => setState({ customerId: "" })}
        />
      ) : null}

      {meta?.stageTotals ? (
        <section
          aria-label="Totals by stage"
          className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-border px-4 py-3 text-sm sm:grid-cols-3 lg:grid-cols-6"
        >
          {STAGES.map((s) => (
            <div key={s}>
              <p className="text-muted-foreground">{STAGE_LABELS[s]}</p>
              <p className="font-semibold tabular-nums">
                {meta.stageTotals![s].count} {meta.stageTotals![s].count === 1 ? "deal" : "deals"} ·{" "}
                {formatUsd(meta.stageTotals![s].amountCents, { whole: true })}
              </p>
            </div>
          ))}
        </section>
      ) : null}

      {query.isError ? (
        <ErrorAlert
          title="Opportunities could not be loaded"
          message={
            isClientApiError(query.error) ? query.error.message : "Something went wrong. Try again."
          }
          requestId={isClientApiError(query.error) ? query.error.requestId : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {query.isPending ? (
        <TableSkeleton label="Loading opportunities" columns={7} rows={8} />
      ) : query.data && total === 0 && !filtered ? (
        <EmptyState
          icon={<Target />}
          title="No opportunities yet"
          description={
            canWrite
              ? "Add a deal to start tracking your pipeline."
              : "No opportunities have been added to this workspace yet."
          }
          action={
            canWrite ? (
              <Link href="/app/opportunities/new" className={buttonVariants()}>
                <Plus aria-hidden="true" />
                Create your first opportunity
              </Link>
            ) : undefined
          }
        />
      ) : query.data && (total === 0 || pastTheEnd) ? (
        <EmptyState
          icon={<Search />}
          title={pastTheEnd ? "There are no opportunities on this page" : "No opportunities match"}
          description={
            pastTheEnd
              ? "The list has fewer pages than that."
              : "Nothing matches the current search and filters. Try fewer words or clear the filters."
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
            role="region"
            aria-label="Opportunities table"
            // a scrollable region must be focusable so the table can scroll sideways with the keyboard
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            aria-busy={query.isFetching}
            className={cn(
              "overflow-x-auto rounded-lg border border-border outline-none focus-visible:ring-3 focus-visible:ring-ring",
              query.isPlaceholderData && "opacity-60",
            )}
          >
            <table className="w-full min-w-[56rem] text-left text-sm">
              <caption className="sr-only">
                Opportunities, page {state.page} of {Math.max(totalPages, 1)}, {total} in total
              </caption>
              <thead className="border-b border-border bg-muted/50">
                {table.getHeaderGroups().map((group) => (
                  <tr key={group.id}>
                    {group.headers.map((header) => {
                      const key = sortKeyOf[header.column.id];
                      return (
                        <th
                          key={header.id}
                          scope="col"
                          aria-sort={
                            key && state.sort === key
                              ? state.order === "asc"
                                ? "ascending"
                                : "descending"
                              : undefined
                          }
                          className="px-3 py-2 font-medium whitespace-nowrap"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className="relative border-b border-border last:border-0 hover:bg-muted/40"
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2 align-middle">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
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
                Rows per page
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
