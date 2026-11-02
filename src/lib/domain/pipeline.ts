import { z } from "zod";

/**
 * Stage rules and pipeline math: the ONE implementation, used by the opportunity API, the board, the dashboard and the
 * reports (PRD US-04, 11.1). Pure functions over integer cents; nothing here uses floating point money.
 *
 * Rounding: the weighted amount of a row is `round(amountCents * probability / 100)` with **round half up** (a result
 * ending in exactly .5 goes up), done per row and then summed, exactly as the PRD specifies and as the dashboard SQL
 * (`floor((amount_cents * probability + 50) / 100)`) must. Products are computed with BigInt, so a very large amount
 * cannot lose precision; a total that no longer fits in a JavaScript safe integer throws instead of being wrong.
 */

export const STAGES = ["new", "qualified", "proposal", "negotiation", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];

/** Shared with API schemas, so the server and the forms agree on the list. */
export const stageSchema = z.enum(STAGES);

export const OPEN_STAGES = ["new", "qualified", "proposal", "negotiation"] as const;
export type OpenStage = (typeof OPEN_STAGES)[number];
export const CLOSED_STAGES = ["won", "lost"] as const;

export const STAGE_LABELS: Readonly<Record<Stage, string>> = {
  new: "New",
  qualified: "Qualified",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

/** Default win probability (percent) for each stage. */
export const DEFAULT_PROBABILITY: Readonly<Record<Stage, number>> = {
  new: 10,
  qualified: 25,
  proposal: 50,
  negotiation: 75,
  won: 100,
  lost: 0,
};

/** A deal's probability is a whole percent from 0 to 100. */
export const probabilitySchema = z.number().int().min(0).max(100);

export const LOST_REASON_MAX = 500;

export function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

export function isOpenStage(stage: Stage): stage is OpenStage {
  return (OPEN_STAGES as readonly Stage[]).includes(stage);
}

// ---- money math ------------------------------------------------------------------------------------------------------

function assertCents(value: number | bigint, name: string): bigint {
  if (typeof value === "bigint") {
    if (value < BigInt(0)) throw new RangeError(`${name} must not be negative`);
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a whole, non-negative number of cents`);
  }
  return BigInt(value);
}

function toSafeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${what} is too large to represent exactly`);
  }
  return Number(value);
}

/** `round(amountCents * probability / 100)`, half up, exact for any size. */
export function weightedAmountCents(amountCents: number | bigint, probability: number): number {
  const amount = assertCents(amountCents, "amountCents");
  if (!Number.isInteger(probability) || probability < 0 || probability > 100) {
    throw new RangeError("probability must be a whole percent from 0 to 100");
  }
  // For non-negative integers, floor((n + 50) / 100) is round-half-up of n / 100.
  return toSafeNumber(
    (amount * BigInt(probability) + BigInt(50)) / BigInt(100),
    "The weighted amount",
  );
}

export type PipelineRow = {
  stage: Stage;
  amountCents: number | bigint;
  /** The row's own probability (percent). Defaults to the stage's when the row has none. */
  probability?: number;
};

function openRows<T extends PipelineRow>(rows: readonly T[]): T[] {
  return rows.filter((row) => isOpenStage(row.stage));
}

/** Sum of the amounts of OPEN deals. Won and lost deals are not pipeline. */
export function pipelineTotal(rows: readonly PipelineRow[]): number {
  let total = BigInt(0);
  for (const row of openRows(rows)) total += assertCents(row.amountCents, "amountCents");
  return toSafeNumber(total, "The pipeline total");
}

/** Sum over OPEN deals of each row's weighted amount (rounded per row, then added). */
export function weightedPipeline(rows: readonly PipelineRow[]): number {
  let total = BigInt(0);
  for (const row of openRows(rows)) {
    total += BigInt(
      weightedAmountCents(row.amountCents, row.probability ?? DEFAULT_PROBABILITY[row.stage]),
    );
  }
  return toSafeNumber(total, "The weighted pipeline");
}

export type StageTotals = Record<Stage, { count: number; amountCents: number }>;

/** Count and summed amount per stage, for the board's column headers. Every stage is present, empty ones as zero. */
export function totalsByStage(rows: readonly PipelineRow[]): StageTotals {
  const sums = Object.fromEntries(STAGES.map((s) => [s, BigInt(0)])) as Record<Stage, bigint>;
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const row of rows) {
    sums[row.stage] += assertCents(row.amountCents, "amountCents");
    counts[row.stage] += 1;
  }
  return Object.fromEntries(
    STAGES.map((s) => [
      s,
      { count: counts[s], amountCents: toSafeNumber(sums[s], "A stage total") },
    ]),
  ) as StageTotals;
}

// ---- transitions -----------------------------------------------------------------------------------------------------

/** The fields a stage change reads and writes. */
export type DealState = {
  stage: Stage;
  probability: number;
  closedAt: Date | null;
  lostReason: string | null;
};

export type TransitionError = "LOST_REASON_REQUIRED" | "LOST_REASON_TOO_LONG" | "UNKNOWN_STAGE";

export type TransitionResult =
  | { ok: true; changed: boolean; next: DealState }
  | { ok: false; error: TransitionError; message: string };

const CODE_POINTS = (text: string) => Array.from(text).length;

/**
 * Moves a deal to another stage and returns what its fields become:
 * - **won** and **lost** set `closedAt` to `now`; **lost** requires a reason (1 to 500 characters after trimming) and
 *   stores it; won clears any lost reason;
 * - moving from won or lost back to an open stage (**reopening**) clears `closedAt` and `lostReason`;
 * - the probability becomes the new stage's default (100 for won, 0 for lost);
 * - moving to the stage it is already in changes nothing.
 * It never mutates its input.
 */
export function transitionStage(
  current: DealState,
  to: Stage,
  options: { reason?: string | null; now: Date },
): TransitionResult {
  if (!isStage(to)) {
    return { ok: false, error: "UNKNOWN_STAGE", message: "That is not a pipeline stage." };
  }
  if (to === current.stage) return { ok: true, changed: false, next: { ...current } };

  if (to === "lost") {
    const reason = (options.reason ?? "").trim();
    if (reason === "") {
      return { ok: false, error: "LOST_REASON_REQUIRED", message: "Say why this deal was lost." };
    }
    if (CODE_POINTS(reason) > LOST_REASON_MAX) {
      return {
        ok: false,
        error: "LOST_REASON_TOO_LONG",
        message: `The reason can be at most ${LOST_REASON_MAX} characters.`,
      };
    }
    return {
      ok: true,
      changed: true,
      next: {
        stage: "lost",
        probability: DEFAULT_PROBABILITY.lost,
        closedAt: options.now,
        lostReason: reason,
      },
    };
  }

  if (to === "won") {
    return {
      ok: true,
      changed: true,
      next: {
        stage: "won",
        probability: DEFAULT_PROBABILITY.won,
        closedAt: options.now,
        lostReason: null,
      },
    };
  }

  // An open stage: reopening from won/lost clears the close; open to open keeps nothing closed to clear.
  return {
    ok: true,
    changed: true,
    next: { stage: to, probability: DEFAULT_PROBABILITY[to], closedAt: null, lostReason: null },
  };
}
