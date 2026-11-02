import { CircleCheck, CircleDot, CircleX } from "lucide-react";
import { STAGE_LABELS, type Stage } from "@/lib/domain/pipeline";

/** Stage as an icon AND a word, never colour alone. */
export function StageLabel({ stage }: { stage: Stage }) {
  const Icon = stage === "won" ? CircleCheck : stage === "lost" ? CircleX : CircleDot;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      {STAGE_LABELS[stage]}
    </span>
  );
}
