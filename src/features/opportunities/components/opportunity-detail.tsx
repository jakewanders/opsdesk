"use client";

import { CircleCheck, CircleDot, CircleX } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { notify } from "@/components/shared/toast";
import { buttonVariants } from "@/components/ui/button";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiQuery } from "@/lib/api-client/provider";
import { useApiMutation } from "@/lib/api-client/use-api-mutation";
import {
  isOpenStage,
  STAGES,
  STAGE_LABELS,
  weightedAmountCents,
  type Stage,
} from "@/lib/domain/pipeline";
import { formatUsd } from "@/lib/money/format";
import type { MemberDto } from "@/features/members/service";
import type { OpportunityDto } from "../schema";
import { LostReasonDialog } from "./lost-reason-dialog";

type Props = { initial: OpportunityDto; canWrite: boolean };

const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const SELECT =
  "h-9 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-50";

/** Stage as an icon AND a word, never colour alone. */
export function StageBadge({ stage }: { stage: Stage }) {
  const Icon = stage === "won" ? CircleCheck : stage === "lost" ? CircleX : CircleDot;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-sm font-medium">
      <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
      {STAGE_LABELS[stage]}
    </span>
  );
}

/**
 * One opportunity: stage, amount, weighted value, owner and the rest, with the stage control (the only place a stage
 * changes besides the board). Lost asks for a reason first. A stale version or a refusal shows a message here and the
 * deal is reloaded; nothing is shown as saved until the API has said so.
 */
export function OpportunityDetail({ initial, canWrite }: Props) {
  const query = useApiQuery<OpportunityDto>(
    ["opportunity", initial.id],
    `/opportunities/${initial.id}`,
    {
      initialData: { data: initial, meta: {} },
      staleTime: 30_000,
    },
  );
  const members = useApiQuery<MemberDto[]>(["members"], "/members");
  const deal = query.data?.data ?? initial;
  const [lostOpen, setLostOpen] = useState(false);
  const [problem, setProblem] = useState<{ message: string; stale: boolean } | null>(null);
  const [pendingTo, setPendingTo] = useState<Stage | null>(null);

  const move = useApiMutation<OpportunityDto, { to: Stage; reason?: string }>({
    mutationFn: ({ to, reason }, { call }) =>
      call(`/opportunities/${deal.id}/stage`, {
        method: "POST",
        json: { stage: to, lostReason: reason ?? null, expectedUpdatedAt: deal.updatedAt },
      }),
    invalidate: [["opportunity", deal.id], ["opportunities-board"], ["dashboard"]],
  });
  const change = async (to: Stage, reason?: string) => {
    setProblem(null);
    setPendingTo(to);
    try {
      await move.mutateAsync({ to, reason });
      notify.success(`Moved to ${STAGE_LABELS[to]}`, deal.title);
    } catch (error) {
      if (isClientApiError(error) && error.isStaleEdit)
        setProblem({
          message:
            "Someone else changed this opportunity. It has been reloaded; try the move again.",
          stale: true,
        });
      else if (isClientApiError(error) && error.status === 403)
        setProblem({
          message: "You do not have permission to move opportunities in this workspace.",
          stale: false,
        });
      else
        setProblem({
          message: isClientApiError(error)
            ? error.message
            : "The stage was not changed. Try again.",
          stale: false,
        });
    } finally {
      setPendingTo(null);
    }
  };

  const owner =
    deal.assignedTo === null
      ? "Unassigned"
      : (members.data?.data.find((m) => m.userId === deal.assignedTo)?.displayName ?? "Teammate");
  const open = isOpenStage(deal.stage);
  const shownStage = pendingTo ?? deal.stage;

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{deal.title}</h1>
          <StageBadge stage={deal.stage} />
          {deal.archivedAt ? (
            <span className="text-sm text-muted-foreground">(archived)</span>
          ) : null}
        </div>
        <p className="text-muted-foreground">
          for{" "}
          <Link
            href={`/app/customers/${deal.customerId}`}
            className="font-medium text-foreground underline underline-offset-2"
          >
            {deal.customerName ?? "customer"}
          </Link>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {canWrite ? (
            <>
              <Link href={`/app/opportunities/${deal.id}/edit`} className={buttonVariants()}>
                Edit
              </Link>
              <div className="flex items-center gap-2 text-sm">
                <label htmlFor="stage-control" className="font-medium">
                  Stage
                </label>
                <select
                  id="stage-control"
                  className={SELECT}
                  value={shownStage}
                  disabled={move.isPending}
                  onChange={(e) => {
                    const to = e.target.value as Stage;
                    if (to === deal.stage) return;
                    if (to === "lost") setLostOpen(true);
                    else void change(to);
                  }}
                >
                  {STAGES.map((s) => (
                    <option key={s} value={s}>
                      {STAGE_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : null}
          <Link href="/app/opportunities" className={buttonVariants({ variant: "outline" })}>
            Back to pipeline
          </Link>
        </div>
        {problem ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive-subtle p-3 text-sm"
          >
            {problem.message}
          </div>
        ) : null}
      </header>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 rounded-lg border border-border p-4 text-sm sm:grid-cols-2">
        <Item label="Amount" value={formatUsd(deal.amountCents)} />
        <Item label="Probability" value={`${deal.probabilityPercent}%`} />
        <Item
          label="Weighted value"
          value={
            open
              ? formatUsd(weightedAmountCents(deal.amountCents, deal.probabilityPercent))
              : "Not in the open pipeline"
          }
        />
        <Item label="Owner" value={owner} />
        <Item
          label="Expected close date"
          value={
            deal.expectedCloseDate
              ? day.format(new Date(`${deal.expectedCloseDate}T00:00:00Z`))
              : "Not set"
          }
        />
        {deal.closedAt ? <Item label="Closed" value={day.format(new Date(deal.closedAt))} /> : null}
        <Item label="Created" value={when.format(new Date(deal.createdAt))} />
        <Item label="Last updated" value={when.format(new Date(deal.updatedAt))} />
      </dl>

      {deal.stage === "lost" && deal.lostReason ? (
        <section
          aria-labelledby="lost-heading"
          className="rounded-lg border border-border p-4 text-sm"
        >
          <h2 id="lost-heading" className="font-semibold">
            Why it was lost
          </h2>
          <p className="mt-1 whitespace-pre-wrap">{deal.lostReason}</p>
        </section>
      ) : null}

      <section aria-labelledby="description-heading" className="text-sm">
        <h2 id="description-heading" className="font-semibold">
          Description
        </h2>
        {/* rendered as text, never as markup */}
        <p className="mt-1 whitespace-pre-wrap">
          {deal.description ?? <span className="text-muted-foreground">No description.</span>}
        </p>
      </section>

      <LostReasonDialog
        deal={lostOpen ? deal : null}
        onCancel={() => setLostOpen(false)}
        onConfirm={(_deal, reason) => {
          setLostOpen(false);
          void change("lost", reason);
        }}
      />
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
