import { describe, expect, it } from "vitest";
import {
  CLOSED_STAGES,
  DEFAULT_PROBABILITY,
  isOpenStage,
  isStage,
  LOST_REASON_MAX,
  OPEN_STAGES,
  pipelineTotal,
  probabilitySchema,
  STAGE_LABELS,
  STAGES,
  stageSchema,
  totalsByStage,
  transitionStage,
  weightedAmountCents,
  weightedPipeline,
  type DealState,
  type PipelineRow,
  type Stage,
} from "./pipeline";

const NOW = new Date("2026-11-02T12:00:00Z");

describe("stages", () => {
  it("are the six PRD stages, in order, with labels", () => {
    expect([...STAGES]).toEqual(["new", "qualified", "proposal", "negotiation", "won", "lost"]);
    expect(STAGES.map((s) => STAGE_LABELS[s])).toEqual([
      "New",
      "Qualified",
      "Proposal",
      "Negotiation",
      "Won",
      "Lost",
    ]);
  });
  it("default probabilities are 10/25/50/75/100/0", () => {
    expect(STAGES.map((s) => DEFAULT_PROBABILITY[s])).toEqual([10, 25, 50, 75, 100, 0]);
  });
  it("open stages are new, qualified, proposal, negotiation; won and lost are closed", () => {
    expect([...OPEN_STAGES]).toEqual(["new", "qualified", "proposal", "negotiation"]);
    expect([...CLOSED_STAGES]).toEqual(["won", "lost"]);
    for (const s of OPEN_STAGES) expect(isOpenStage(s)).toBe(true);
    for (const s of CLOSED_STAGES) expect(isOpenStage(s)).toBe(false);
  });
  it("the Zod enum and the guard accept exactly the stages", () => {
    for (const s of STAGES) {
      expect(stageSchema.safeParse(s).success).toBe(true);
      expect(isStage(s)).toBe(true);
    }
    for (const bad of ["NEW", "open", "", null, undefined, 3, "won "]) {
      expect(stageSchema.safeParse(bad).success, String(bad)).toBe(false);
      expect(isStage(bad)).toBe(false);
    }
  });
  it("probability is a whole percent from 0 to 100", () => {
    for (const ok of [0, 1, 50, 100]) expect(probabilitySchema.safeParse(ok).success).toBe(true);
    for (const bad of [-1, 101, 12.5, "50", NaN])
      expect(probabilitySchema.safeParse(bad).success, String(bad)).toBe(false);
  });
});

describe("weightedAmountCents: round half up, per row", () => {
  it.each([
    // [amount, probability, expected]
    [0, 50, 0],
    [1, 50, 1], // 0.5 rounds up to 1
    [1, 49, 0], // 0.49 rounds down
    [1, 51, 1],
    [1, 10, 0], // 0.1
    [1, 100, 1],
    [1, 0, 0],
    [3, 50, 2], // 1.5 -> 2
    [5, 10, 1], // 0.5 -> 1
    [15, 10, 2], // 1.5 -> 2
    [25, 10, 3], // 2.5 -> 3
    [4, 25, 1], // exactly 1
    [99_999, 75, 74_999], // 74999.25
    [100_001, 75, 75_001], // 75000.75
    [10_000_00, 25, 250_000],
    [7, 7, 0], // 0.49
    [8, 7, 1], // 0.56
  ])("amount %i at %i%% is %i", (amount, probability, expected) => {
    expect(weightedAmountCents(amount, probability)).toBe(expected);
  });
  it("is exact for very large amounts (no float drift)", () => {
    // 9_007_199_254_740_991 is Number.MAX_SAFE_INTEGER; times 75 would lose precision in floating point.
    expect(weightedAmountCents(9_007_199_254_740_991, 100)).toBe(9_007_199_254_740_991);
    expect(weightedAmountCents(9_007_199_254_740_991, 50)).toBe(4_503_599_627_370_496); // .5 up
    expect(weightedAmountCents(BigInt("9007199254740991"), 0)).toBe(0);
    expect(weightedAmountCents(1_000_000_000_000_001, 75)).toBe(750_000_000_000_001); // ...000.75 -> up
  });
  it("accepts bigint amounts and refuses a result that cannot be exact", () => {
    expect(weightedAmountCents(BigInt(200), 50)).toBe(100);
    expect(() => weightedAmountCents(BigInt("99999999999999999999"), 100)).toThrow(RangeError);
  });
  it("rejects fractional, negative or unsafe cents and out-of-range probabilities", () => {
    for (const cents of [1.5, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => weightedAmountCents(cents, 50), String(cents)).toThrow(RangeError);
    }
    expect(() => weightedAmountCents(BigInt(-1), 50)).toThrow(RangeError);
    for (const p of [-1, 101, 50.5, NaN])
      expect(() => weightedAmountCents(100, p), String(p)).toThrow(RangeError);
  });
});

const row = (stage: Stage, amountCents: number, probability?: number): PipelineRow => ({
  stage,
  amountCents,
  probability,
});

describe("pipelineTotal and weightedPipeline count OPEN stages only", () => {
  const rows: PipelineRow[] = [
    row("new", 100_00),
    row("qualified", 200_00),
    row("proposal", 300_00),
    row("negotiation", 400_00),
    row("won", 5_000_00),
    row("lost", 7_000_00),
  ];
  it("excludes won and lost from the total", () => {
    expect(pipelineTotal(rows)).toBe(1_000_00);
    expect(pipelineTotal(rows.filter((r) => isOpenStage(r.stage)))).toBe(1_000_00);
  });
  it("weights each open row by its stage default, rounding per row", () => {
    // 10% of 100.00 + 25% of 200.00 + 50% of 300.00 + 75% of 400.00 = 10 + 50 + 150 + 300 dollars
    expect(weightedPipeline(rows)).toBe(510_00);
  });
  it("an empty pipeline, or only closed deals, is zero", () => {
    expect(pipelineTotal([])).toBe(0);
    expect(weightedPipeline([])).toBe(0);
    expect(pipelineTotal([row("won", 100), row("lost", 100)])).toBe(0);
    expect(weightedPipeline([row("won", 100), row("lost", 100)])).toBe(0);
  });
  it("uses a row's own probability when it has one", () => {
    expect(weightedPipeline([row("new", 1000, 90)])).toBe(900);
    expect(weightedPipeline([row("new", 1000, 0)])).toBe(0);
  });
  it("rounds per row, THEN sums (not the sum's rounding)", () => {
    // three rows of 1 cent at 50%: each rounds to 1 -> 3; rounding the sum (1.5) would give 2
    expect(weightedPipeline([row("new", 1, 50), row("new", 1, 50), row("new", 1, 50)])).toBe(3);
    // three rows of 1 cent at 10%: each rounds to 0 -> 0; rounding the sum (0.3) would also be 0
    expect(weightedPipeline([row("new", 1), row("new", 1), row("new", 1)])).toBe(0);
  });
  it("sums large amounts exactly and refuses an unrepresentable total", () => {
    const big = Number.MAX_SAFE_INTEGER;
    expect(pipelineTotal([row("new", big)])).toBe(big);
    expect(() => pipelineTotal([row("new", big), row("new", big)])).toThrow(RangeError);
  });
  it("does not change its input", () => {
    const copy = JSON.stringify(rows);
    pipelineTotal(rows);
    weightedPipeline(rows);
    totalsByStage(rows);
    expect(JSON.stringify(rows)).toBe(copy);
  });
});

describe("totalsByStage", () => {
  it("has every stage, empty ones as zero, and counts closed stages too", () => {
    const totals = totalsByStage([row("new", 100), row("new", 250), row("won", 1000)]);
    expect(Object.keys(totals)).toEqual([...STAGES]);
    expect(totals.new).toEqual({ count: 2, amountCents: 350 });
    expect(totals.won).toEqual({ count: 1, amountCents: 1000 });
    expect(totals.qualified).toEqual({ count: 0, amountCents: 0 });
  });
});

const open = (stage: Stage = "new"): DealState => ({
  stage,
  probability: DEFAULT_PROBABILITY[stage],
  closedAt: null,
  lostReason: null,
});

describe("transitionStage", () => {
  it("won sets closedAt, probability 100, and no lost reason", () => {
    const r = transitionStage(open("negotiation"), "won", { now: NOW });
    expect(r).toEqual({
      ok: true,
      changed: true,
      next: { stage: "won", probability: 100, closedAt: NOW, lostReason: null },
    });
  });
  it("lost requires a reason", () => {
    for (const reason of [undefined, null, "", "   ", "\n\t"]) {
      const r = transitionStage(open("proposal"), "lost", { reason, now: NOW });
      expect(r, String(reason)).toMatchObject({ ok: false, error: "LOST_REASON_REQUIRED" });
    }
  });
  it("lost with a reason sets closedAt, probability 0 and stores the trimmed reason", () => {
    const r = transitionStage(open("proposal"), "lost", {
      reason: "  Chose a competitor  ",
      now: NOW,
    });
    expect(r).toEqual({
      ok: true,
      changed: true,
      next: { stage: "lost", probability: 0, closedAt: NOW, lostReason: "Chose a competitor" },
    });
  });
  it("the reason limit is 500 characters (code points) after trimming", () => {
    expect(
      transitionStage(open(), "lost", { reason: "x".repeat(LOST_REASON_MAX), now: NOW }).ok,
    ).toBe(true);
    expect(
      transitionStage(open(), "lost", { reason: "x".repeat(LOST_REASON_MAX + 1), now: NOW }),
    ).toMatchObject({ ok: false, error: "LOST_REASON_TOO_LONG" });
    expect(
      transitionStage(open(), "lost", { reason: " " + "x".repeat(LOST_REASON_MAX) + " ", now: NOW })
        .ok,
    ).toBe(true);
    // an emoji is one character, as the database counts it
    expect(
      transitionStage(open(), "lost", { reason: "😀".repeat(LOST_REASON_MAX), now: NOW }).ok,
    ).toBe(true);
    expect(
      transitionStage(open(), "lost", { reason: "😀".repeat(LOST_REASON_MAX + 1), now: NOW }).ok,
    ).toBe(false);
  });
  it("reopening from won or lost clears closedAt and lostReason and restores the stage default probability", () => {
    const lost: DealState = {
      stage: "lost",
      probability: 0,
      closedAt: NOW,
      lostReason: "Too expensive",
    };
    expect(transitionStage(lost, "qualified", { now: new Date() })).toEqual({
      ok: true,
      changed: true,
      next: { stage: "qualified", probability: 25, closedAt: null, lostReason: null },
    });
    const won: DealState = { stage: "won", probability: 100, closedAt: NOW, lostReason: null };
    expect(transitionStage(won, "new", { now: new Date() })).toMatchObject({
      ok: true,
      next: { stage: "new", probability: 10, closedAt: null },
    });
  });
  it("won straight to lost needs a reason, and lost straight to won drops it", () => {
    const won: DealState = { stage: "won", probability: 100, closedAt: NOW, lostReason: null };
    expect(transitionStage(won, "lost", { now: NOW })).toMatchObject({
      ok: false,
      error: "LOST_REASON_REQUIRED",
    });
    const lost: DealState = { stage: "lost", probability: 0, closedAt: NOW, lostReason: "x" };
    expect(transitionStage(lost, "won", { now: NOW })).toMatchObject({
      ok: true,
      next: { lostReason: null, stage: "won" },
    });
  });
  it("open to open changes the stage and probability and keeps nothing closed", () => {
    expect(transitionStage(open("new"), "proposal", { now: NOW })).toEqual({
      ok: true,
      changed: true,
      next: { stage: "proposal", probability: 50, closedAt: null, lostReason: null },
    });
  });
  it("a reason sent with a non-lost stage is ignored", () => {
    expect(transitionStage(open(), "qualified", { reason: "stray", now: NOW })).toMatchObject({
      next: { lostReason: null },
    });
  });
  it("the same stage is a no-op (closedAt and the reason are kept, `changed` is false)", () => {
    const lost: DealState = { stage: "lost", probability: 0, closedAt: NOW, lostReason: "kept" };
    expect(transitionStage(lost, "lost", { reason: "different", now: new Date() })).toEqual({
      ok: true,
      changed: false,
      next: lost,
    });
  });
  it("an unknown stage is refused", () => {
    expect(transitionStage(open(), "archived" as Stage, { now: NOW })).toMatchObject({
      ok: false,
      error: "UNKNOWN_STAGE",
    });
  });
  it("never mutates its input or shares the returned object with it", () => {
    const cur = open("new");
    const snapshot = JSON.stringify(cur);
    const same = transitionStage(cur, "new", { now: NOW });
    transitionStage(cur, "won", { now: NOW });
    expect(JSON.stringify(cur)).toBe(snapshot);
    if (same.ok) expect(same.next).not.toBe(cur);
  });
  it("every stage pair behaves: closed stages carry closedAt, open stages never do (table check)", () => {
    for (const from of STAGES) {
      for (const to of STAGES) {
        const cur: DealState = {
          stage: from,
          probability: DEFAULT_PROBABILITY[from],
          closedAt: isOpenStage(from) ? null : NOW,
          lostReason: from === "lost" ? "r" : null,
        };
        const r = transitionStage(cur, to, {
          reason: "because",
          now: new Date("2027-01-01T00:00:00Z"),
        });
        expect(r.ok, `${from}->${to}`).toBe(true);
        if (!r.ok) continue;
        expect(r.next.stage).toBe(to);
        expect(r.next.closedAt === null, `${from}->${to}`).toBe(isOpenStage(to));
        expect(r.next.lostReason !== null, `${from}->${to}`).toBe(
          to === "lost" && from !== "lost" ? true : to === "lost" && from === "lost",
        );
      }
    }
  });
});
