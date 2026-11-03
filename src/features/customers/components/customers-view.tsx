"use client";

import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Building2,
  MoreHorizontal,
  Plus,
  Search,
  Upload,
  User,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorAlert } from "@/components/shared/error-alert";
import { TableSkeleton } from "@/components/shared/skeletons";
import { notify } from "@/components/shared/toast";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiQuery } from "@/lib/api-client/provider";
import { serializeUrlState } from "@/lib/api-client/url-state";
import { useApiMutation } from "@/lib/api-client/use-api-mutation";
import { useDebouncedUrlParam, useUrlState } from "@/lib/api-client/use-url-state";
import type { ApiMeta } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import {
  customerListUrl,
  hasActiveFilters,
  PAGE_SIZES,
  toApiQuery,
  type CustomerListState,
} from "../list-state";
import { CUSTOMER_SOURCES, CUSTOMER_STATUSES, type CustomerDto } from "../schema";
import { ArchiveCustomerDialog } from "./archive-customer-dialog";
import { CustomerStatus, STATUS_LABELS } from "./customer-status";

type SortKey = CustomerListState["sort"];
type Initial = { items: CustomerDto[]; meta: ApiMeta } | null;

type Props = {
  /** The first page, read on the server with the caller's session. Null if that read failed (the browser retries). */
  initial: Initial;
  /** The URL state the server rendered; the first read is only reused while the URL still matches. */
  initialState: CustomerListState;
  /** Owner, admin and member may add and archive; viewers see the table without write actions. */
  canWrite: boolean;
  currentUserId: string;
  /** The organization's time zone, so server and browser format dates the same way. */
  timeZone: string;
  /** Writers may import a CSV while the import feature is on. */
  canImport?: boolean;
};

const SOURCE_LABELS = {
  referral: "Referral",
  website: "Website",
  outbound: "Outbound",
  other: "Other",
} as const;
const columnHelper = createColumnHelper<CustomerDto>();

function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone }).format(new Date(iso));
}

function SortHeader({
  label,
  sortKey,
  state,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  state: CustomerListState;
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
 * The customer list: search, filters, sorting and paging all live in the URL; the first page comes from the server,
 * then TanStack Query keeps it current. Every state is covered (loading, empty, no results, error) and all controls are
 * native, keyboard-operable elements.
 */
export function CustomersView({
  initial,
  initialState,
  canWrite,
  currentUserId,
  timeZone,
  canImport = false,
}: Props) {
  const [state, setState] = useUrlState(customerListUrl);
  const [search, onSearch] = useDebouncedUrlParam(state.q, (q) => setState({ q }));
  const [archiving, setArchiving] = useState<CustomerDto | null>(null);
  /** The row whose menu opened the archive dialog; focus goes back to that row's actions button. */
  const openerId = useRef<string | null>(null);

  const apiQuery = toApiQuery(state);
  const sameAsServer =
    serializeUrlState(customerListUrl, state) === serializeUrlState(customerListUrl, initialState);
  const query = useApiQuery<CustomerDto[]>(["customers", apiQuery], "/customers", {
    query: apiQuery,
    initialData: sameAsServer && initial ? { data: initial.items, meta: initial.meta } : undefined,
    keepPrevious: true,
    // the server just read this page; don't read it again the moment the browser mounts
    staleTime: sameAsServer && initial ? 30_000 : undefined,
  });
  const restore = useApiMutation<unknown, CustomerDto>({
    mutationFn: (customer, { call }) =>
      call(`/customers/${customer.id}/restore`, { method: "POST" }),
    invalidate: [["customers"], ["dashboard"]],
  });
  const restoreNow = async (customer: CustomerDto) => {
    try {
      await restore.mutateAsync(customer);
      notify.success("Customer restored", customer.displayName);
    } catch (error) {
      notify.error(
        "Customer not restored",
        isClientApiError(error)
          ? `${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`
          : "Try again.",
      );
    }
  };

  const items = useMemo(() => query.data?.data ?? [], [query.data]);
  const meta = query.data?.meta;
  const total = Number(meta?.total ?? 0);
  const totalPages = Number(meta?.totalPages ?? 0);
  const filtered = hasActiveFilters(state);

  const onSort = (key: SortKey) =>
    setState(
      state.sort === key
        ? { order: state.order === "asc" ? "desc" : "asc" }
        : { sort: key, order: key === "updated_at" ? "desc" : "asc" },
    );

  const columns = useMemo(
    () => [
      columnHelper.accessor("displayName", {
        header: () => (
          <SortHeader label="Name" sortKey="display_name" state={state} onSort={onSort} />
        ),
        cell: ({ row }) => (
          <Link
            href={`/app/customers/${row.original.id}`}
            className="inline-flex items-center gap-2 rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring"
          >
            {row.original.type === "company" ? (
              <Building2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <User aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span>
              {row.original.displayName}
              <span className="sr-only">
                {row.original.type === "company" ? " (company)" : " (person)"}
              </span>
            </span>
            {row.original.archivedAt ? (
              <span className="text-xs font-normal text-muted-foreground">(archived)</span>
            ) : null}
          </Link>
        ),
      }),
      columnHelper.accessor("companyName", {
        header: "Company",
        cell: (c) => c.getValue() ?? <span aria-label="None">-</span>,
      }),
      columnHelper.accessor("status", {
        header: () => <SortHeader label="Status" sortKey="status" state={state} onSort={onSort} />,
        cell: (c) => <CustomerStatus status={c.getValue()} />,
      }),
      columnHelper.accessor("email", {
        header: "Email",
        cell: (c) => c.getValue() ?? <span aria-label="None">-</span>,
      }),
      columnHelper.accessor("assignedTo", {
        header: "Owner",
        cell: (c) =>
          c.getValue() === null
            ? "Unassigned"
            : c.getValue() === currentUserId
              ? "You"
              : "Teammate",
      }),
      columnHelper.accessor("updatedAt", {
        header: () => (
          <SortHeader label="Last updated" sortKey="updated_at" state={state} onSort={onSort} />
        ),
        cell: (c) => (
          <time dateTime={c.getValue()} title={new Date(c.getValue()).toISOString()}>
            {formatDate(c.getValue(), timeZone)}
          </time>
        ),
      }),
      columnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Actions for ${row.original.displayName}`}
                data-customer-actions={row.original.id}
              >
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/app/customers/${row.original.id}`}>View details</Link>
              </DropdownMenuItem>
              {canWrite ? (
                <DropdownMenuItem asChild>
                  <Link href={`/app/customers/${row.original.id}/edit`}>Edit</Link>
                </DropdownMenuItem>
              ) : null}
              {canWrite && !row.original.archivedAt ? (
                <DropdownMenuItem
                  onSelect={() => {
                    openerId.current = row.original.id;
                    setArchiving(row.original);
                  }}
                >
                  Archive
                </DropdownMenuItem>
              ) : null}
              {canWrite && row.original.archivedAt ? (
                <DropdownMenuItem onSelect={() => void restoreNow(row.original)}>
                  Restore
                </DropdownMenuItem>
              ) : null}
              {!canWrite && !row.original.archivedAt ? (
                <DropdownMenuItem disabled>Archive (needs edit access)</DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSort closes over state, which is listed
    [state, canWrite, currentUserId, timeZone],
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

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
        <div className="flex flex-wrap items-center gap-2">
          {canImport ? (
            <Link href="/app/customers/import" className={buttonVariants({ variant: "outline" })}>
              <Upload aria-hidden="true" />
              Import CSV
            </Link>
          ) : null}
          {canWrite ? (
            <Link href="/app/customers/new" className={buttonVariants()}>
              <Plus aria-hidden="true" />
              Add customer
            </Link>
          ) : null}
        </div>
      </header>

      <form
        role="search"
        aria-label="Filter customers"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="flex min-w-56 flex-1 flex-col gap-1 text-sm font-medium">
          <label htmlFor="customer-search">Search</label>
          <span className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="customer-search"
              type="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Name, company or email"
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
            className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring"
          >
            <option value="">All statuses</option>
            {CUSTOMER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Source
          <select
            value={state.source}
            onChange={(e) => setState({ source: e.target.value })}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring"
          >
            <option value="">All sources</option>
            {CUSTOMER_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Show
          <select
            value={state.archived}
            onChange={(e) => setState({ archived: e.target.value })}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring"
          >
            <option value="false">Active customers</option>
            <option value="true">Archived</option>
          </select>
        </label>
        {filtered ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setState({ q: "", status: "", source: "", archived: "false" })}
          >
            Clear filters
          </Button>
        ) : null}
      </form>

      {query.isError ? (
        <ErrorAlert
          title="Customers could not be loaded"
          message={
            isClientApiError(query.error) ? query.error.message : "Something went wrong. Try again."
          }
          requestId={isClientApiError(query.error) ? query.error.requestId : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {query.isPending ? (
        <TableSkeleton label="Loading customers" columns={6} rows={8} />
      ) : query.data && total === 0 && !filtered ? (
        <EmptyState
          icon={<Users />}
          title="No customers yet"
          description={
            canWrite
              ? "Add your first customer to start tracking leads, deals and tasks."
              : "No customers have been added to this workspace yet."
          }
          action={
            canWrite ? (
              <Link href="/app/customers/new" className={buttonVariants()}>
                <Plus aria-hidden="true" />
                Add your first customer
              </Link>
            ) : undefined
          }
        />
      ) : query.data && (total === 0 || pastTheEnd) ? (
        <EmptyState
          icon={<Search />}
          title={pastTheEnd ? "There are no customers on this page" : "No customers match"}
          description={
            pastTheEnd
              ? "The list has fewer pages than that."
              : "Nothing matches the current search and filters. Try fewer words or clear the filters."
          }
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setState(
                  pastTheEnd ? { page: 1 } : { q: "", status: "", source: "", archived: "false" },
                )
              }
            >
              {pastTheEnd ? "Go to the first page" : "Clear filters"}
            </Button>
          }
        />
      ) : query.data ? (
        <>
          <div
            role="region"
            aria-label="Customers table"
            // scrollable region must be keyboard-focusable so the table can scroll sideways without a mouse
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            className={cn(
              "overflow-x-auto rounded-lg border border-border outline-none focus-visible:ring-3 focus-visible:ring-ring",
              query.isPlaceholderData && "opacity-60",
            )}
            aria-busy={query.isFetching}
          >
            <table className="w-full min-w-[56rem] text-left text-sm">
              <caption className="sr-only">
                Customers, page {state.page} of {Math.max(totalPages, 1)}, {total} in total
              </caption>
              <thead className="border-b border-border bg-muted/50">
                {table.getHeaderGroups().map((group) => (
                  <tr key={group.id}>
                    {group.headers.map((header) => {
                      const sortKey = {
                        displayName: "display_name",
                        status: "status",
                        updatedAt: "updated_at",
                      }[header.column.id];
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
                    className="border-b border-border last:border-0 hover:bg-muted/40"
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
                  value={state.limit}
                  onChange={(e) => setState({ limit: Number(e.target.value) })}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring"
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

      <ArchiveCustomerDialog
        customer={archiving}
        onClose={() => setArchiving(null)}
        fallbackFocus={() =>
          document.querySelector<HTMLElement>(`[data-customer-actions="${openerId.current}"]`)
        }
      />
    </div>
  );
}
