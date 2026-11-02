import { STAGES, STAGE_LABELS, type Stage } from "@/lib/domain/pipeline";
import { formatUsd } from "@/lib/money/format";
import type { DashboardDto } from "../service";

export type StageRow = {
  stage: Stage;
  label: string;
  count: number;
  amountCents: number;
  /** The text on the bar: the same numbers the table shows. */
  valueLabel: string;
};

/** The chart's and the table's rows, in pipeline order, straight from the dashboard payload (nothing recomputed). */
export function stageRows(byStage: DashboardDto["opportunitiesByStage"]): StageRow[] {
  return STAGES.map((stage) => {
    const { count, amountCents } = byStage[stage];
    return {
      stage,
      label: STAGE_LABELS[stage],
      count,
      amountCents,
      valueLabel: `${count} ${count === 1 ? "deal" : "deals"}, ${formatUsd(amountCents, { whole: true })}`,
    };
  });
}
