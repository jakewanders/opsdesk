"use client";

import Link from "next/link";
import { useState } from "react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ErrorAlert } from "@/components/shared/error-alert";
import { Plus } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiQuery } from "@/lib/api-client/provider";
import { useDebouncedUrlParam, useUrlState } from "@/lib/api-client/use-url-state";
import type { ApiMeta } from "@/lib/api/types";
import { OPEN_STAGES, STAGES, STAGE_LABELS, type Stage } from "@/lib/domain/pipeline";
import { formatUsd } from "@/lib/money/format";
import { cn } from "@/lib/utils";
import type { MemberDto } from "@/features/members/service";
import { opportunityFilterUrl } from "../filter-state";
import type { PipelineTotals } from "../pipeline-model";
import type { OpportunityDto } from "../schema";
import { BOARD_KEY, useMoveStage, type Move } from "../use-move-stage";
import { BoardDnd, DragHandle, useStageDrop } from "./board-dnd";
import { LostReasonDialog } from "./lost-reason-dialog";

const PAGE = 10;
const SELECT =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-50";

type Totals = ApiMeta & Partial<PipelineTotals>;
type Props = { canWrite: boolean; currentUserId: string };

const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const formatDay = (value: string) =>
  day.format(new Date(value.length === 10 ? `${value}T00:00:00Z` : value));

/**
 * The pipeline as columns (PRD 9.4). Column headers and the summary bar come from ONE query of the whole filtered set
 * (`meta.stageTotals`, `openPipelineCents`, `weightedPipelineCents`: the domain module's numbers computed by the API), the
 * cards from one small query per column. Moving a deal through the stage menu updates card, totals and probability
 * at once and rolls everything back if the API refuses.
 */
export function PipelineBoard({ canWrite, currentUserId }: Props) {
  const [filters, setFilters] = useUrlState(opportunityFilterUrl);
  const [search, onSearch] = useDebouncedUrlParam(filters.q, (q) => setFilters({ q }));
  const [lostFor, setLostFor] = useState<OpportunityDto | null>(null);
  const [wonFor, setWonFor] = useState<OpportunityDto | null>(null);
  const move = useMoveStage();

  const base = {
    q: filters.q || undefined,
    assignedTo: filters.assignedTo || undefined,
    sort: "updated_at",
    order: "desc",
  };
  const members = useApiQuery<MemberDto[]>(["members"], "/members");
  const summary = useApiQuery<OpportunityDto[]>([...BOARD_KEY, "summary", base], "/opportunities", {
    query: { ...base, limit: 1 },
    keepPrevious: true,
  });
  const totals = summary.data?.meta as Totals | undefined;
  const ownerName = (id: string | null) =>
    id === null
      ? "Unassigned"
      : (members.data?.data.find((m) => m.userId === id)?.displayName ?? "Teammate");

  const request = (deal: OpportunityDto, to: Stage) => {
    if (to === deal.stage) return;
    if (to === "lost") setLostFor(deal);
    else move.mutate({ deal, to } satisfies Move);
  };
  // A drop asks for a move like the menu does, except that Won first asks for a confirmation.
  const drop = (deal: OpportunityDto, to: Stage) => {
    if (to === "won") setWonFor(deal);
    else request(deal, to);
  };
  const filtered = Boolean(filters.q || filters.assignedTo);
  const openDeals = totals?.stageTotals
    ? OPEN_STAGES.reduce((n, s) => n + totals.stageTotals![s].count, 0)
    : null;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
        {canWrite ? (
          <Link href="/app/opportunities/new" className={buttonVariants()}>
            <Plus aria-hidden="true" />
            Add opportunity
          </Link>
        ) : null}
      </header>

      <form
        role="search"
        aria-label="Filter the pipeline"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="flex min-w-56 flex-1 flex-col gap-1 text-sm font-medium">
          <label htmlFor="pipeline-search">Search</label>
          <Input
            id="pipeline-search"
            type="search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Deal or customer name"
            autoComplete="off"
            maxLength={100}
          />
        </div>
        <div className="flex min-w-44 flex-col gap-1 text-sm font-medium">
          <label htmlFor="pipeline-owner">Owner</label>
          <select
            id="pipeline-owner"
            className={SELECT}
            value={filters.assignedTo}
            onChange={(e) => setFilters({ assignedTo: e.target.value })}
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
        {filtered ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setFilters({ q: "", assignedTo: "" })}
          >
            Clear filters
          </Button>
        ) : null}
      </form>

      {summary.isError ? (
        <ErrorAlert
          title="The pipeline could not be loaded"
          message={
            isClientApiError(summary.error)
              ? summary.error.message
              : "Something went wrong. Try again."
          }
          requestId={isClientApiError(summary.error) ? summary.error.requestId : undefined}
          onRetry={() => void summary.refetch()}
        />
      ) : null}

      <section
        aria-label="Pipeline totals"
        aria-live="polite"
        className="grid grid-cols-1 gap-x-8 gap-y-2 rounded-lg border border-border px-4 py-3 sm:grid-cols-3"
      >
        <Stat
          label="Open pipeline"
          value={
            totals?.openPipelineCents === undefined ? null : formatUsd(totals.openPipelineCents)
          }
        />
        <Stat
          label="Weighted pipeline"
          value={
            totals?.weightedPipelineCents === undefined
              ? null
              : formatUsd(totals.weightedPipelineCents)
          }
        />
        <Stat label="Open deals" value={openDeals === null ? null : String(openDeals)} />
      </section>

      <div
        role="region"
        aria-label="Pipeline board"
        // a scrollable region must be focusable so the board can scroll sideways with the keyboard
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="overflow-x-auto pb-2 outline-none focus-visible:ring-3 focus-visible:ring-ring"
      >
        <BoardDnd enabled={canWrite && !move.isPending} onDrop={drop}>
          <div className="grid min-w-[72rem] grid-cols-6 gap-3">
            {STAGES.map((stage) => (
              <Column
                key={stage}
                stage={stage}
                base={base}
                total={totals?.stageTotals?.[stage]}
                loadingTotals={summary.isPending}
                filtered={filtered}
                canWrite={canWrite}
                busy={move.isPending}
                ownerName={ownerName}
                onMove={request}
              />
            ))}
          </div>
        </BoardDnd>
      </div>

      <ConfirmDialog
        open={wonFor !== null}
        onOpenChange={(open) => {
          if (!open) setWonFor(null);
        }}
        title="Mark as won?"
        description={
          wonFor ? (
            <>
              <strong>{wonFor.title}</strong> moves to Won, its probability becomes 100%, and it
              closes today (
              {new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date())}). You
              can reopen it later.
            </>
          ) : null
        }
        confirmLabel="Mark as won"
        onConfirm={() => {
          if (wonFor) move.mutate({ deal: wonFor, to: "won" });
          setWonFor(null);
        }}
      />

      <LostReasonDialog
        deal={lostFor}
        onCancel={() => setLostFor(null)}
        onConfirm={(deal, lostReason) => {
          setLostFor(null);
          move.mutate({ deal, to: "lost", lostReason });
        }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">
        {value ?? <span aria-label="Loading">...</span>}
      </p>
    </div>
  );
}

type ColumnProps = {
  stage: Stage;
  base: Record<string, string | undefined>;
  total: { count: number; amountCents: number } | undefined;
  loadingTotals: boolean;
  filtered: boolean;
  canWrite: boolean;
  busy: boolean;
  ownerName: (id: string | null) => string;
  onMove: (deal: OpportunityDto, to: Stage) => void;
};

function Column({
  stage,
  base,
  total,
  loadingTotals,
  filtered,
  canWrite,
  busy,
  ownerName,
  onMove,
}: ColumnProps) {
  const [limit, setLimit] = useState(PAGE);
  const { setRef, isOver, dragging, props: dropProps } = useStageDrop(stage);
  const query = useApiQuery<OpportunityDto[]>(
    [...BOARD_KEY, "column", stage, base, limit],
    "/opportunities",
    {
      query: { ...base, stage, limit },
      keepPrevious: true,
    },
  );
  const deals = query.data?.data ?? [];
  const label = STAGE_LABELS[stage];
  const headingId = `stage-${stage}`;
  const remaining = total ? Math.max(0, total.count - deals.length) : 0;

  return (
    <section
      ref={setRef}
      {...dropProps}
      aria-labelledby={headingId}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg bg-muted/40 p-2 transition-shadow",
        dragging && "outline-1 outline-dashed outline-border",
        isOver && "bg-muted ring-2 ring-ring",
      )}
    >
      <header className="px-1 pt-1">
        <h2 id={headingId} className="text-sm font-semibold">
          {label}
        </h2>
        <p className="text-sm text-muted-foreground tabular-nums">
          {total ? (
            <>
              {total.count} {total.count === 1 ? "deal" : "deals"} ·{" "}
              {formatUsd(total.amountCents, { whole: true })}
            </>
          ) : loadingTotals ? (
            <span aria-label="Loading">...</span>
          ) : (
            "-"
          )}
        </p>
      </header>

      {query.isPending ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading {label} deals</span>
          <div aria-hidden="true" className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        </div>
      ) : query.isError ? (
        <div role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm">
          <p>Could not load {label} deals.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : deals.length === 0 ? (
        <p className="px-1 py-3 text-sm text-muted-foreground">
          {filtered ? `No ${label} deals match.` : `No deals in ${label}.`}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {deals.map((deal) => (
            <li key={deal.id}>
              <Card
                deal={deal}
                canWrite={canWrite}
                busy={busy}
                owner={ownerName(deal.assignedTo)}
                onMove={onMove}
              />
            </li>
          ))}
        </ul>
      )}

      {remaining > 0 ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setLimit((n) => n + PAGE)}>
          Show {Math.min(PAGE, remaining)} more ({remaining} left)
        </Button>
      ) : null}
    </section>
  );
}

function Card({
  deal,
  canWrite,
  busy,
  owner,
  onMove,
}: {
  deal: OpportunityDto;
  canWrite: boolean;
  busy: boolean;
  owner: string;
  onMove: ColumnProps["onMove"];
}) {
  const selectId = `move-${deal.id}`;
  return (
    <article className="relative flex flex-col gap-1.5 rounded-lg border border-border bg-background p-3 text-sm shadow-xs focus-within:ring-3 focus-within:ring-ring">
      <div className="flex items-start justify-between gap-2">
        <p className="text-muted-foreground">{deal.customerName ?? "Customer"}</p>
        {canWrite ? <DragHandle deal={deal} disabled={busy} /> : null}
      </div>
      <h3 className="font-medium">
        <Link
          href={`/app/opportunities/${deal.id}`}
          className="outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:underline hover:underline"
        >
          {deal.title}
        </Link>
      </h3>
      <p className="font-semibold tabular-nums">
        {formatUsd(deal.amountCents)}{" "}
        <span className="font-normal text-muted-foreground">· {deal.probabilityPercent}%</span>
      </p>
      <p className="text-muted-foreground">{owner}</p>
      {deal.closedAt ? (
        <p className="text-muted-foreground">Closed {formatDay(deal.closedAt)}</p>
      ) : deal.expectedCloseDate ? (
        <p className="text-muted-foreground">Expected {formatDay(deal.expectedCloseDate)}</p>
      ) : null}
      {canWrite ? (
        <div className="relative z-10 mt-1">
          <label htmlFor={selectId} className="sr-only">
            Move {deal.title} to another stage
          </label>
          <select
            id={selectId}
            className={SELECT}
            value={deal.stage}
            disabled={busy}
            onChange={(e) => onMove(deal, e.target.value as Stage)}
          >
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </article>
  );
}
