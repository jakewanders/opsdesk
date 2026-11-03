"use client";

import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useFieldArray, useWatch, type UseFormReturn } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatUsd } from "@/lib/money/format";
import { parseUsdToCents } from "@/lib/money/parse";
import { cn } from "@/lib/utils";
import { EMPTY_LINE, parseQuantity, type QuoteFormValues } from "../form-values";

type Props = {
  form: UseFormReturn<QuoteFormValues>;
  disabled: boolean;
};

export const rowId = (index: number, field: "description" | "quantity" | "unitPrice") =>
  `quote-item-${index}-${field}`;

/**
 * Up and down step to the neighbouring line. Only used while a line is lifted by its grip with the keyboard (the move buttons
 * are the primary way to reorder, and never need drag and drop).
 */
const lineCoordinateGetter: KeyboardCoordinateGetter = (
  event,
  { context: { active, droppableRects, over, droppableContainers } },
) => {
  if (event.code !== "ArrowUp" && event.code !== "ArrowDown") return undefined;
  const ids = [...droppableContainers.getEnabled()].map((c) => String(c.id));
  const from = String(over?.id ?? active?.id ?? "");
  const next = ids[ids.indexOf(from) + (event.code === "ArrowDown" ? 1 : -1)];
  const rect = next ? droppableRects.get(next) : undefined;
  if (!rect) return undefined;
  event.preventDefault();
  return { x: rect.left + 8, y: rect.top + 8 };
};

function Row({
  index,
  count,
  id,
  form,
  disabled,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  id: string;
  form: UseFormReturn<QuoteFormValues>;
  disabled: boolean;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}) {
  const { register, control, formState } = form;
  const { setNodeRef: dropRef, isOver } = useDroppable({ id });
  const { attributes, listeners, setNodeRef: dragRef, isDragging } = useDraggable({ id, disabled });
  const item = useWatch({ control, name: `items.${index}` });
  const rowErrors = formState.errors.items?.[index];
  const quantity = parseQuantity(item?.quantity ?? "");
  const price = parseUsdToCents(item?.unitPrice ?? "");
  const lineTotal = quantity.ok && price.ok ? formatUsd(quantity.quantity * price.cents) : "—";
  const n = index + 1;
  const cell = (field: "description" | "quantity" | "unitPrice") => {
    const message = rowErrors?.[field]?.message;
    return {
      id: rowId(index, field),
      "aria-invalid": message ? (true as const) : undefined,
      "aria-describedby": message ? `${rowId(index, field)}-error` : undefined,
      error: typeof message === "string" ? message : undefined,
    };
  };
  const d = cell("description");
  const q = cell("quantity");
  const p = cell("unitPrice");
  const err = (c: { id: string; error?: string }) =>
    c.error ? (
      <p id={`${c.id}-error`} className="mt-1 text-xs font-medium text-destructive">
        <span className="sr-only">Error: </span>
        {c.error}
      </p>
    ) : null;
  return (
    <tr
      ref={dropRef}
      className={cn("align-top", isOver && "bg-accent/50", isDragging && "opacity-60")}
      data-testid={`quote-line-${n}`}
    >
      <th scope="row" className="px-2 py-2 text-left font-normal">
        <div className="flex items-center gap-1">
          <span
            className="w-5 text-right text-sm tabular-nums text-muted-foreground"
            aria-hidden="true"
          >
            {n}
          </span>
          <Button
            ref={dragRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled || count < 2}
            aria-label={`Drag line ${n} to reorder`}
            {...attributes}
            {...listeners}
            className="cursor-grab touch-none"
          >
            <GripVertical aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled || index === 0}
            aria-label={`Move line ${n} up`}
            onClick={() => onMove(index, index - 1)}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled || index === count - 1}
            aria-label={`Move line ${n} down`}
            onClick={() => onMove(index, index + 1)}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
        </div>
      </th>
      <td className="min-w-48 px-2 py-2">
        <Input
          {...register(`items.${index}.description`)}
          id={d.id}
          aria-label={`Description, line ${n}`}
          aria-invalid={d["aria-invalid"]}
          aria-describedby={d["aria-describedby"]}
          autoComplete="off"
          disabled={disabled}
        />
        {err(d)}
      </td>
      <td className="w-24 px-2 py-2">
        <Input
          {...register(`items.${index}.quantity`)}
          id={q.id}
          aria-label={`Quantity, line ${n}`}
          aria-invalid={q["aria-invalid"]}
          aria-describedby={q["aria-describedby"]}
          inputMode="numeric"
          autoComplete="off"
          className="text-right tabular-nums"
          disabled={disabled}
        />
        {err(q)}
      </td>
      <td className="w-36 px-2 py-2">
        <Input
          {...register(`items.${index}.unitPrice`)}
          id={p.id}
          aria-label={`Unit price in dollars, line ${n}`}
          aria-invalid={p["aria-invalid"]}
          aria-describedby={p["aria-describedby"]}
          inputMode="decimal"
          autoComplete="off"
          className="text-right tabular-nums"
          disabled={disabled}
        />
        {err(p)}
      </td>
      <td className="w-32 px-2 py-3 text-right text-sm tabular-nums">
        <span className="sr-only">Line total: </span>
        {lineTotal}
      </td>
      <td className="w-10 px-1 py-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || count < 2}
          aria-label={`Remove line ${n}`}
          onClick={() => onRemove(index)}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </td>
    </tr>
  );
}

/**
 * The line items as a real table. Every line can be reordered with its up and down buttons (so a keyboard or switch user never
 * needs drag and drop); the grip is an enhancement: lift it with Space or Enter, move with the arrow keys, drop with Space or
 * Enter. The new position is announced in a polite status region, and positions are what the form saves.
 */
export function LineItems({ form, disabled }: Props) {
  const { control, formState } = form;
  const { fields, append, remove, move } = useFieldArray({ control, name: "items" });
  const [status, setStatus] = useState("");
  const rootError = formState.errors.items?.root?.message;

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: lineCoordinateGetter }),
  );
  const numberOf = (id: unknown) => fields.findIndex((f) => f.id === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up line ${numberOf(active.id)} of ${fields.length}. Use the up and down arrow keys to move it, then space to drop.`,
    onDragOver: ({ over }) => (over ? `Over line ${numberOf(over.id)}.` : undefined),
    onDragEnd: ({ active, over }) =>
      over && over.id !== active.id
        ? `Dropped line ${numberOf(active.id)} on line ${numberOf(over.id)}.`
        : `Line ${numberOf(active.id)} was not moved.`,
    onDragCancel: ({ active }) => `Move cancelled. Line ${numberOf(active.id)} stays where it was.`,
  };

  const moveLine = (from: number, to: number) => {
    if (to < 0 || to >= fields.length || from === to) return;
    move(from, to);
    setStatus(`Line moved to position ${to + 1} of ${fields.length}.`);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || over.id === active.id) return;
    const from = fields.findIndex((f) => f.id === active.id);
    const to = fields.findIndex((f) => f.id === over.id);
    if (from >= 0 && to >= 0) moveLine(from, to);
  };

  return (
    <section aria-labelledby="quote-lines-title" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="quote-lines-title" className="text-lg font-semibold">
          Line items
        </h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || fields.length >= 100}
          onClick={() => append({ ...EMPTY_LINE })}
        >
          <Plus aria-hidden="true" />
          Add line
        </Button>
      </div>
      {rootError ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          <span className="sr-only">Error: </span>
          {rootError}
        </p>
      ) : null}
      <DndContext
        id="quote-lines-dnd"
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              "To reorder, press space or enter on a line's grip, use the up and down arrow keys, then press space to drop. The move up and move down buttons do the same.",
          },
        }}
        onDragEnd={onDragEnd}
      >
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Line items of this quote, in the order they will appear. Totals update as you type.
            </caption>
            <thead className="border-b border-border bg-muted/50">
              <tr>
                <th scope="col" className="px-2 py-2 text-left font-medium">
                  <span className="sr-only">Order</span>
                  <span aria-hidden="true">#</span>
                </th>
                <th scope="col" className="px-2 py-2 text-left font-medium">
                  Description
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Quantity
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Unit price (USD)
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Line total
                </th>
                <th scope="col" className="px-1 py-2">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {fields.map((field, index) => (
                <Row
                  key={field.id}
                  id={field.id}
                  index={index}
                  count={fields.length}
                  form={form}
                  disabled={disabled}
                  onMove={moveLine}
                  onRemove={(i) => {
                    remove(i);
                    setStatus(`Line ${i + 1} removed.`);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      </DndContext>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
        {status}
      </p>
    </section>
  );
}
