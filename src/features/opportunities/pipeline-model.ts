import {
  DEFAULT_PROBABILITY,
  OPEN_STAGES,
  STAGES,
  isOpenStage,
  weightedAmountCents,
  type Stage,
  type StageTotals,
} from "@/lib/domain/pipeline";
import type { OpportunityDto } from "./schema";

/** The totals the list endpoint puts in `meta` for the filtered set. */
export type PipelineTotals = {
  stageTotals: StageTotals;
  openPipelineCents: number;
  weightedPipelineCents: number;
};

/** What a deal becomes in `to`, as the stage endpoint will leave it (probability reset, close and reason rules). */
export function movedDeal(
  deal: OpportunityDto,
  to: Stage,
  options: { lostReason?: string | null; now: Date },
): OpportunityDto {
  if (to === deal.stage) return deal;
  const closed = to === "won" || to === "lost";
  return {
    ...deal,
    stage: to,
    probabilityPercent: DEFAULT_PROBABILITY[to],
    closedAt: closed ? options.now.toISOString() : null,
    lostReason: to === "lost" ? (options.lostReason?.trim() ?? null) : null,
  };
}

const sumOpen = (totals: StageTotals) =>
  OPEN_STAGES.reduce((sum, stage) => sum + totals[stage].amountCents, 0);

/**
 * The page totals after one deal moves. Counts and sums per stage shift by the deal's amount; the open pipeline is the sum
 * of the open stages; the weighted pipeline changes by the deal's weighted amount in its new stage minus in its old one
 * (rounded per deal, exactly as the domain module and the API do). The server's answer replaces this once it arrives.
 */
export function totalsAfterMove(
  totals: PipelineTotals,
  deal: OpportunityDto,
  to: Stage,
): PipelineTotals {
  if (to === deal.stage) return totals;
  const stageTotals = Object.fromEntries(
    STAGES.map((s) => [s, { ...totals.stageTotals[s] }]),
  ) as StageTotals;
  stageTotals[deal.stage].count -= 1;
  stageTotals[deal.stage].amountCents -= deal.amountCents;
  stageTotals[to].count += 1;
  stageTotals[to].amountCents += deal.amountCents;

  const before = isOpenStage(deal.stage)
    ? weightedAmountCents(deal.amountCents, deal.probabilityPercent)
    : 0;
  const after = isOpenStage(to)
    ? weightedAmountCents(deal.amountCents, DEFAULT_PROBABILITY[to])
    : 0;
  return {
    stageTotals,
    openPipelineCents: sumOpen(stageTotals),
    weightedPipelineCents: totals.weightedPipelineCents - before + after,
  };
}
