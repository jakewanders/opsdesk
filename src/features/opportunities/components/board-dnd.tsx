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
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { STAGES, STAGE_LABELS, isStage, type Stage } from "@/lib/domain/pipeline";
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

/** What a screen reader hears while a card is lifted, moved and dropped. */
export const announcements: Announcements = {
  onDragStart: ({ active }) => {
    const deal = dealOf(active.data);
    return `Picked up ${deal?.title ?? "the deal"}. It is in ${label(deal?.stage)}. Use the left and right arrow keys to choose a stage.`;
  },
  onDragOver: ({ active, over }) => {
    const deal = dealOf(active.data);
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

const REDUCED = "(prefers-reduced-motion: reduce)";
function useReducedMotion() {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(REDUCED);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}

type ProviderProps = {
  children: ReactNode;
  /** Whether cards can be picked up (writers, and not while a move is running). */
  enabled: boolean;
  onDrop: (deal: OpportunityDto, to: Stage) => void;
};

export function BoardDnd({ children, enabled, onDrop }: ProviderProps) {
  const [active, setActive] = useState<OpportunityDto | null>(null);
  const reduced = useReducedMotion();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: stageCoordinateGetter }),
  );

  const end = ({ active: a, over }: DragEndEvent) => {
    setActive(null);
    const deal = dealOf(a.data);
    if (deal && enabled && over && isStage(over.id) && over.id !== deal.stage)
      onDrop(deal, over.id);
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
      <DragOverlay dropAnimation={reduced ? null : undefined}>
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
