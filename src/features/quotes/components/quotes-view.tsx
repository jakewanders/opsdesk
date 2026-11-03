"use client";

import { ScopeNote } from "@/components/shared/scope-note";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, FileText, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorAlert } from "@/components/shared/error-alert";
import { TableSkeleton } from "@/components/shared/skeletons";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiQuery } from "@/lib/api-client/provider";
import { serializeUrlState } from "@/lib/api-client/url-state";
import { useDebouncedUrlParam, useUrlState } from "@/lib/api-client/use-url-state";
import { useRememberList } from "@/lib/api-client/use-remember-list";
import { CopyLinkButton } from "@/components/shared/copy-link-button";
import type { ApiMeta } from "@/lib/api/types";
import type { CustomerDto } from "@/features/customers/schema";
import { formatUsd } from "@/lib/money/format";
import { cn } from "@/lib/utils";
import {
  hasActiveFilters,
  PAGE_SIZES,
  quoteListUrl,
  toApiQuery,
  type QuoteListState,
} from "../list-state";
import { QUOTE_STATUSES, type QuoteDto } from "../schema";
import { QUOTE_STATUS_LABELS, QuoteStatus } from "./quote-status";

type SortKey = QuoteListState["sort"];
type Initial = { items: QuoteDto[]; meta: ApiMeta } | null;

type Props = {
  /** The first page, read on the server with the caller's session. Null if that read failed (the browser retries). */
  initial: Initial;
  /** The URL state the server rendered; the first read is only reused while the URL still matches. */
  initialState: QuoteListState;
  /** Owner, admin and member (and a demo guest) may start quotes; viewers read. */
  canWrite: boolean;
};

const columnHelper = createColumnHelper<QuoteDto>();
const DAY = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
/** Issue and valid-until dates are calendar days, not instants: format them as the day they name. */
const day = (iso: string) => DAY.format(new Date(`${iso}T00:00:00Z`));
const CONTROL =
  "h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring";
const CLEAR = { q: "", status: "", customerId: "", issueFrom: "", issueTo: "", archived: "false" };

function SortHeader({
  label,
  sortKey,
  state,
  onSort,
  align,
}: {
  label: string;
  sortKey: SortKey;
  state: QuoteListState;
  onSort: (key: SortKey) => void;
  align?: "right";
}) {
  const active = state.sort === sortKey;
  const Icon = !active ? ArrowUpDown : state.order === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={cn(
        "-mx-2 inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring",
        align === "right" && "flex-row-reverse",
      )}
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
 * The quote list (PRD 9.6): number, title, customer, status, total, issue and valid-until dates. Search, filters (status, customer, issue
 * date range), sorting and paging all live in the URL; the first page comes from the server, then TanStack Query keeps it current.
 * Every state is covered (loading, empty, no results, error). Totals are the server's numbers, formatted with the shared formatter.
 */
export function QuotesView({ initial, initialState, canWrite }: Props) {
  const [state, setState] = useUrlState(quoteListUrl);
  useRememberList("quotes");
  const [search, onSearch] = useDebouncedUrlParam(state.q, (q) => setState({ q }));

  const apiQuery = toApiQuery(state);
  const sameAsServer =
    serializeUrlState(quoteListUrl, state) === serializeUrlState(quoteListUrl, initialState);
  const query = useApiQuery<QuoteDto[]>(["quotes", apiQuery], "/quotes", {
    query: apiQuery,
    initialData: sameAsServer && initial ? { data: initial.items, meta: initial.meta } : undefined,
    keepPrevious: true,
    staleTime: sameAsServer && initial ? 30_000 : undefined,
  });
  const customers = useApiQuery<CustomerDto[]>(
    ["customers", { picker: "quotes-filter" }],
    "/customers",
    { query: { limit: 100, sort: "display_name", order: "asc" } },
  );
  const customerOptions = customers.data?.data ?? [];

  const items = useMemo(() => query.data?.data ?? [], [query.data]);
  const meta = query.data?.meta;
  const total = Number(meta?.total ?? 0);
  const totalPages = Number(meta?.totalPages ?? 0);
  const filtered = hasActiveFilters(state);

  const onSort = (key: SortKey) =>
    setState(
      state.sort === key
        ? { order: state.order === "asc" ? "desc" : "asc" }
        : { sort: key, order: key === "updated_at" || key === "total_cents" ? "desc" : "asc" },
    );

  const columns = useMemo(
    () => [
      columnHelper.accessor("quoteNumber", {
        header: () => (
          <SortHeader label="Number" sortKey="quote_number" state={state} onSort={onSort} />
        ),
        cell: ({ row }) => (
          <Link
            href={`/app/quotes/${row.original.id}`}
            className="rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring"
          >
            {row.original.quoteNumber}
          </Link>
        ),
      }),
      columnHelper.accessor("title", {
        header: () => <SortHeader label="Title" sortKey="title" state={state} onSort={onSort} />,
        cell: (c) => <span className="line-clamp-2 max-w-xs">{c.getValue()}</span>,
      }),
      columnHelper.accessor("customerName", {
        header: "Customer",
        cell: (c) => c.getValue() ?? <span aria-label="Unknown">-</span>,
      }),
      columnHelper.accessor("status", {
        header: () => <SortHeader label="Status" sortKey="status" state={state} onSort={onSort} />,
        cell: (c) => <QuoteStatus status={c.getValue()} />,
      }),
      columnHelper.accessor("totalCents", {
        header: () => (
          <SortHeader
            label="Total"
            sortKey="total_cents"
            state={state}
            onSort={onSort}
            align="right"
          />
        ),
        cell: (c) => <span className="tabular-nums">{formatUsd(c.getValue())}</span>,
      }),
      columnHelper.accessor("issueDate", {
        header: () => (
          <SortHeader label="Issued" sortKey="issue_date" state={state} onSort={onSort} />
        ),
        cell: (c) => <time dateTime={c.getValue()}>{day(c.getValue())}</time>,
      }),
      columnHelper.accessor("validUntil", {
        header: "Valid until",
        cell: (c) =>
          c.getValue() ? (
            <time dateTime={c.getValue()!}>{day(c.getValue()!)}</time>
          ) : (
            <span className="text-muted-foreground">No end date</span>
          ),
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSort closes over state, which is listed
    [state],
  );
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is opted out of memoization; nothing here is passed to memoized children
  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
  });

  const from = total === 0 ? 0 : (state.page - 1) * state.limit + 1;
  const to = Math.min(total, (state.page - 1) * state.limit + items.length);
  const pastTheEnd = items.length === 0 && total > 0;
  const SORT_BY_COLUMN: Record<string, string> = {
    quoteNumber: "quote_number",
    title: "title",
    status: "status",
    totalCents: "total_cents",
    issueDate: "issue_date",
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Quotes</h1>
        <div className="flex flex-wrap items-center gap-2">
          <CopyLinkButton />
          {canWrite ? (
            <Link href="/app/quotes/new" className={buttonVariants()}>
              <Plus aria-hidden="true" />
              New quote
            </Link>
          ) : null}
        </div>
      </header>

      <form
        role="search"
        aria-label="Filter quotes"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="flex min-w-56 flex-1 flex-col gap-1 text-sm font-medium">
          <label htmlFor="quote-search">Search</label>
          <span className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="quote-search"
              type="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Quote number or title"
              className="pl-8"
              autoComplete="off"
              maxLength={100}
            />
          </span>
        </div>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Status
          <select
            value={state.status}
            onChange={(e) => setState({ status: e.target.value })}
            className={CONTROL}
          >
            <option value="">All statuses</option>
            {QUOTE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {QUOTE_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Customer
          <select
            value={state.customerId}
            onChange={(e) => setState({ customerId: e.target.value })}
            className={cn(CONTROL, "max-w-56")}
          >
            <option value="">All customers</option>
            {state.customerId && !customerOptions.some((c) => c.id === state.customerId) ? (
              <option value={state.customerId}>Selected customer</option>
            ) : null}
            {customerOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Issued from
          <input
            type="date"
            value={state.issueFrom}
            max={state.issueTo || undefined}
            onChange={(e) => setState({ issueFrom: e.target.value })}
            className={CONTROL}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Issued to
          <input
            type="date"
            value={state.issueTo}
            min={state.issueFrom || undefined}
            onChange={(e) => setState({ issueTo: e.target.value })}
            className={CONTROL}
          />
        </label>
        {filtered ? (
          <Button type="button" variant="ghost" onClick={() => setState(CLEAR)}>
            Clear filters
          </Button>
        ) : null}
      </form>
      {toApiQuery(state).opportunityId ? (
        <ScopeNote
          text="Showing only quotes for one deal."
          onClear={() => setState({ opportunityId: "" })}
        />
      ) : null}

      {query.isError ? (
        <ErrorAlert
          title="Quotes could not be loaded"
          message={
            isClientApiError(query.error) ? query.error.message : "Something went wrong. Try again."
          }
          requestId={isClientApiError(query.error) ? query.error.requestId : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {query.isPending ? (
        <TableSkeleton label="Loading quotes" columns={7} rows={8} />
      ) : query.data && total === 0 && !filtered ? (
        <EmptyState
          icon={<FileText />}
          title="No quotes yet"
          description={
            canWrite
              ? "Create your first quote: pick a customer, add line items, and send it when it is ready."
              : "No quotes have been created in this workspace yet."
          }
          action={
            canWrite ? (
              <Link href="/app/quotes/new" className={buttonVariants()}>
                <Plus aria-hidden="true" />
                Create your first quote
              </Link>
            ) : undefined
          }
        />
      ) : query.data && (total === 0 || pastTheEnd) ? (
        <EmptyState
          icon={<Search />}
          title={pastTheEnd ? "There are no quotes on this page" : "No quotes match"}
          description={
            pastTheEnd
              ? "The list has fewer pages than that."
              : "Nothing matches the current search and filters. Try fewer words or clear the filters."
          }
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => setState(pastTheEnd ? { page: 1 } : CLEAR)}
            >
              {pastTheEnd ? "Go to the first page" : "Clear filters"}
            </Button>
          }
        />
      ) : query.data ? (
        <>
          <div
            role="region"
            aria-label="Quotes table"
            // scrollable region must be keyboard-focusable so the table can scroll sideways without a mouse
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            className={cn(
              "overflow-x-auto rounded-lg border border-border outline-none focus-visible:ring-3 focus-visible:ring-ring",
              query.isPlaceholderData && "opacity-60",
            )}
            aria-busy={query.isFetching}
          >
            <table className="w-full min-w-[52rem] text-left text-sm">
              <caption className="sr-only">
                Quotes, page {state.page} of {Math.max(totalPages, 1)}, {total} in total
              </caption>
              <thead className="border-b border-border bg-muted/50">
                {table.getHeaderGroups().map((group) => (
                  <tr key={group.id}>
                    {group.headers.map((header) => {
                      const sortKey = SORT_BY_COLUMN[header.column.id];
                      return (
                        <th
                          key={header.id}
                          scope="col"
                          aria-sort={
                            sortKey && state.sort === sortKey
                              ? state.order === "asc"
                                ? "ascending"
                                : "descending"
                              : undefined
                          }
                          className={cn(
                            "px-3 py-2 font-medium whitespace-nowrap",
                            header.column.id === "totalCents" && "text-right",
                          )}
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
                    className="border-b border-border last:border-0 hover:bg-muted/40"
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className={cn(
                          "px-3 py-2 align-middle",
                          cell.column.id === "totalCents" && "text-right",
                        )}
                      >
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
                  value={state.limit}
                  onChange={(e) => setState({ limit: Number(e.target.value) })}
                  className={CONTROL}
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
