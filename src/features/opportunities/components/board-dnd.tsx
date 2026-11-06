"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DropAnimation,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { STAGES, STAGE_LABELS, isStage, type Stage } from "@/lib/domain/pipeline";
import { usePrefersReducedMotion } from "@/lib/motion/use-prefers-reduced-motion";
import { formatUsd } from "@/lib/money/format";
import type { OpportunityDto } from "../schema";

/**
 * Drag and drop for the pipeline board is an ENHANCEMENT: every move can also be made with the stage menu on the card. A
 * card is picked up by its handle only (so links, the menu and page scrolling are untouched). Sensors:
 * - mouse: after moving a few pixels;
 * - touch: after a short press, so a swipe still scrolls the page;
 * - keyboard: Space or Enter lifts the handle, Left and Right move between stages, Space or Enter drops, Escape cancels.
 * A drop only ASKS for the move (`onDrop`); the board then moves the card through the stage endpoint, with the same
 * optimistic update and rollback as the menu, and a Won or Lost drop first opens its dialog.
 */

const dealOf = (data: { current?: Record<string, unknown> } | undefined) =>
  data?.current?.deal as OpportunityDto | undefined;

/** Left and Right step to the neighbouring stage; anything else is ignored (Up and Down do nothing). */
export const stageCoordinateGetter: KeyboardCoordinateGetter = (
  event,
  { context: { active, droppableRects, over } },
) => {
  if (event.code !== "ArrowLeft" && event.code !== "ArrowRight") return undefined;
  const from = over && isStage(over.id) ? over.id : dealOf(active?.data)?.stage;
  if (!from) return undefined;
  const index = STAGES.indexOf(from);
  const next = STAGES[index + (event.code === "ArrowRight" ? 1 : -1)];
  const rect = next ? droppableRects.get(next) : undefined;
  if (!rect) return undefined;
  event.preventDefault();
  return { x: rect.left + 8, y: rect.top + 8 };
};

const label = (id: unknown) => (isStage(id) ? STAGE_LABELS[id] : "no stage");

/**
 * dnd-kit reports "over <the card's own column>" in the same tick as the pick-up, which would replace the pick-up
 * announcement (and its instructions) in the live region before a screen reader speaks it. That first, redundant "over" is
 * skipped; every later "over" is announced.
 */
let pickedUpAt = 0;
const SAME_TICK_MS = 100;

/** What a screen reader hears while a card is lifted, moved and dropped. */
export const announcements: Announcements = {
  onDragStart: ({ active }) => {
    pickedUpAt = Date.now();
    const deal = dealOf(active.data);
    return `Picked up ${deal?.title ?? "the deal"}. It is in ${label(deal?.stage)}. Use the left and right arrow keys to choose a stage.`;
  },
  onDragOver: ({ active, over }) => {
    const deal = dealOf(active.data);
    if (over && over.id === deal?.stage && Date.now() - pickedUpAt < SAME_TICK_MS) return undefined;
    return over
      ? `${deal?.title ?? "The deal"} is over ${label(over.id)}.`
      : `${deal?.title ?? "The deal"} is not over a stage.`;
  },
  onDragEnd: ({ active, over }) => {
    const deal = dealOf(active.data);
    if (!over || over.id === deal?.stage)
      return `${deal?.title ?? "The deal"} was not moved. It stays in ${label(deal?.stage)}.`;
    return `Dropped ${deal?.title ?? "the deal"} on ${label(over.id)}.`;
  },
  onDragCancel: ({ active }) => {
    const deal = dealOf(active.data);
    return `Move cancelled. ${deal?.title ?? "The deal"} stays in ${label(deal?.stage)}.`;
  },
};

/**
 * Where a dropped card lands: the top of the destination column, just under its header (a moved deal is put first in its
 * new column). Returns the point the overlay's top-left corner should travel to, or null when the column is not on the page.
 */
export function landingPoint(column: Element | null): { x: number; y: number } | null {
  if (!column) return null;
  const box = column.getBoundingClientRect();
  const header = column.querySelector("header")?.getBoundingClientRect();
  const GAP = 8; // the column's padding and the gap between its cards
  return { x: box.left + GAP, y: (header ? header.bottom : box.top) + GAP };
}

/**
 * dnd-kit's own drop animation flies the overlay to the card's SOURCE node, which is still in the old column when the
 * drop happens, so the card appeared to go back before jumping to the new column. This one flies it to where the card
 * is about to appear: the top of the column it was dropped on.
 */
const flyToColumn =
  (to: Stage): DropAnimation =>
  ({ dragOverlay, transform }) => {
    const node = dragOverlay.node;
    const target = landingPoint(document.querySelector(`[data-stage="${to}"]`) ?? null);
    if (!target || typeof node.animate !== "function") return;
    const now = node.getBoundingClientRect();
    const dx = target.x - now.left;
    const dy = target.y - now.top;
    const at = (x: number, y: number) => `translate3d(${x}px, ${y}px, 0)`;
    const animation = node.animate(
      [
        { transform: at(transform.x, transform.y), opacity: 1 },
        { transform: at(transform.x + dx, transform.y + dy), opacity: 1, offset: 0.85 },
        { transform: at(transform.x + dx, transform.y + dy), opacity: 0 },
      ],
      { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
    );
    return animation.finished.then(() => undefined);
  };

type ProviderProps = {
  children: ReactNode;
  /** Whether cards can be picked up (writers, and not while a move is running). */
  enabled: boolean;
  onDrop: (deal: OpportunityDto, to: Stage) => void;
};

export function BoardDnd({ children, enabled, onDrop }: ProviderProps) {
  const [active, setActive] = useState<OpportunityDto | null>(null);
  const reduced = usePrefersReducedMotion();
  // the stage a card was just dropped on (null when it was not moved): the drop animation flies there
  const [droppedOn, setDroppedOn] = useState<Stage | null>(null);
  const dropAnimation = useMemo(
    () => (droppedOn ? flyToColumn(droppedOn) : undefined),
    [droppedOn],
  );
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: stageCoordinateGetter }),
  );

  const end = ({ active: a, over }: DragEndEvent) => {
    const deal = dealOf(a.data);
    const moved = !!deal && enabled && !!over && isStage(over.id) && over.id !== deal.stage;
    setDroppedOn(moved && over && isStage(over.id) ? over.id : null);
    setActive(null);
    if (moved && deal && over && isStage(over.id)) onDrop(deal, over.id);
  };

  return (
    <DndContext
      id="pipeline-board-dnd"
      sensors={sensors}
      collisionDetection={rectIntersection}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            "To pick up a deal, press space or enter on its drag handle. Use the left and right arrow keys to choose a stage, then press space or enter to drop it. Press escape to cancel. You can also change the stage with the menu on the card.",
        },
      }}
      onDragStart={({ active: a }) => setActive(dealOf(a.data) ?? null)}
      onDragEnd={end}
      onDragCancel={() => setActive(null)}
    >
      {children}
      <DragOverlay dropAnimation={reduced ? null : dropAnimation}>
        {active ? (
          <div className="rounded-lg border border-border bg-background p-3 text-sm shadow-lg">
            <p className="text-muted-foreground">{active.customerName ?? "Customer"}</p>
            <p className="font-medium">{active.title}</p>
            <p className="font-semibold tabular-nums">{formatUsd(active.amountCents)}</p>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/** A column as a drop target. Pass `setRef` as the ref and spread `props` onto the column's section. */
export function useStageDrop(stage: Stage) {
  const { setNodeRef, isOver, active } = useDroppable({ id: stage });
  const dragging = dealOf(active?.data) !== undefined;
  return {
    setRef: setNodeRef,
    isOver,
    dragging,
    props: { "data-stage": stage, "data-drop-over": isOver ? "true" : undefined },
  };
}

/** The handle a card is picked up by. A real button, focusable and operable with the keyboard. */
export function DragHandle({ deal, disabled }: { deal: OpportunityDto; disabled: boolean }) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, isDragging } = useDraggable({
    id: deal.id,
    data: { deal },
    disabled,
  });
  return (
    <button
      ref={(node) => {
        setNodeRef(node);
        setActivatorNodeRef(node);
      }}
      type="button"
      {...attributes}
      {...listeners}
      disabled={disabled}
      aria-label={`Drag ${deal.title}`}
      style={{ touchAction: "none" }}
      className="relative z-10 -mr-1 -mt-1 inline-flex size-7 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-40 aria-pressed:bg-muted"
      data-dragging={isDragging ? "true" : undefined}
    >
      <GripVertical aria-hidden="true" className="size-4" />
    </button>
  );
}
