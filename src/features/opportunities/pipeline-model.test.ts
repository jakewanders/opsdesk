import { describe, expect, it } from "vitest";
import { pipelineTotal, totalsByStage, weightedPipeline, type Stage } from "@/lib/domain/pipeline";
import { movedDeal, totalsAfterMove, type PipelineTotals } from "./pipeline-model";
import type { OpportunityDto } from "./schema";

const NOW = new Date("2026-11-02T12:00:00Z");
const deal = (
  id: string,
  stage: Stage,
  amountCents: number,
  probabilityPercent: number,
): OpportunityDto => ({
  id,
  customerId: "c",
  customerName: "Acme",
  title: id,
  description: null,
  stage,
  amountCents,
  probabilityPercent,
  expectedCloseDate: null,
  assignedTo: null,
  lostReason: null,
  closedAt: stage === "won" || stage === "lost" ? NOW.toISOString() : null,
  createdBy: null,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  archivedAt: null,
});
const FIXTURE = [
  deal("a", "new", 100001, 10),
  deal("b", "qualified", 250003, 25),
  deal("c", "proposal", 750000, 60), // an explicit probability
  deal("d", "negotiation", 1250007, 75),
  deal("e", "won", 900000, 100),
  deal("f", "lost", 400000, 0),
];
const rowsOf = (deals: OpportunityDto[]) =>
  deals.map((d) => ({
    stage: d.stage,
    amountCents: d.amountCents,
    probability: d.probabilityPercent,
  }));
const totalsOf = (deals: OpportunityDto[]): PipelineTotals => ({
  stageTotals: totalsByStage(rowsOf(deals)),
  openPipelineCents: pipelineTotal(rowsOf(deals)),
  weightedPipelineCents: weightedPipeline(rowsOf(deals)),
});

describe("movedDeal", () => {
  it("resets the probability, closes on won/lost, stores the trimmed reason, and clears both on reopening", () => {
    const d = deal("x", "proposal", 1000, 60);
    expect(movedDeal(d, "negotiation", { now: NOW })).toMatchObject({
      stage: "negotiation",
      probabilityPercent: 75,
      closedAt: null,
      lostReason: null,
    });
    expect(movedDeal(d, "won", { now: NOW })).toMatchObject({
      stage: "won",
      probabilityPercent: 100,
      closedAt: NOW.toISOString(),
    });
    const lost = movedDeal(d, "lost", { lostReason: "  Price  ", now: NOW });
    expect(lost).toMatchObject({
      stage: "lost",
      probabilityPercent: 0,
      lostReason: "Price",
      closedAt: NOW.toISOString(),
    });
    expect(movedDeal(lost, "qualified", { now: NOW })).toMatchObject({
      stage: "qualified",
      probabilityPercent: 25,
      closedAt: null,
      lostReason: null,
    });
    expect(movedDeal(d, "proposal", { now: NOW })).toBe(d);
  });
});

describe("totalsAfterMove equals recomputing the totals from the moved deals (all 30 transitions, uneven amounts, an explicit probability)", () => {
  for (const from of FIXTURE) {
    for (const to of ["new", "qualified", "proposal", "negotiation", "won", "lost"] as const) {
      if (to === from.stage) continue;
      it(`${from.stage} to ${to}`, () => {
        const moved = FIXTURE.map((d) =>
          d.id === from.id ? movedDeal(d, to, { lostReason: "x", now: NOW }) : d,
        );
        expect(totalsAfterMove(totalsOf(FIXTURE), from, to)).toEqual(totalsOf(moved));
      });
    }
  }
  it("a move to the current stage changes nothing", () => {
    const t = totalsOf(FIXTURE);
    expect(totalsAfterMove(t, FIXTURE[0], "new")).toBe(t);
  });
  it("does not mutate its input", () => {
    const t = totalsOf(FIXTURE);
    const copy = JSON.stringify(t);
    totalsAfterMove(t, FIXTURE[0], "won");
    expect(JSON.stringify(t)).toBe(copy);
  });
});
