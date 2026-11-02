"use client";

import { KanbanSquare, List } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = { view: "board" | "list"; onChange: (view: "board" | "list") => void };

/** Board / List switch. Two buttons in a labelled group; the current one is `aria-pressed`. */
export function ViewToggle({ view, onChange }: Props) {
  return (
    <div role="group" aria-label="View" className="inline-flex gap-1">
      <Button
        type="button"
        variant={view === "board" ? "secondary" : "outline"}
        size="sm"
        aria-pressed={view === "board"}
        onClick={() => onChange("board")}
      >
        <KanbanSquare aria-hidden="true" />
        Board
      </Button>
      <Button
        type="button"
        variant={view === "list" ? "secondary" : "outline"}
        size="sm"
        aria-pressed={view === "list"}
        onClick={() => onChange("list")}
      >
        <List aria-hidden="true" />
        List
      </Button>
    </div>
  );
}
