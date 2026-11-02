"use client";

import { X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FieldControlProps } from "@/components/shared/form-field";

type Props = {
  value: string[];
  onChange: (tags: string[]) => void;
  control: FieldControlProps;
  disabled?: boolean;
};

/**
 * Tags as chips: type a tag and press Enter (or the Add button); each chip has its own remove button. Enter never submits
 * the form from here. Length and count limits are the schema's, shown with the field's error on save.
 */
export function TagsInput({ value, onChange, control, disabled }: Props) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const tag = draft.trim();
    if (tag === "") return;
    if (!value.some((t) => t.toLowerCase() === tag.toLowerCase())) onChange([...value, tag]);
    setDraft("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      add();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          {...control}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          autoComplete="off"
          placeholder="Add a tag"
        />
        <Button
          type="button"
          variant="outline"
          onClick={add}
          disabled={disabled || draft.trim() === ""}
        >
          Add tag
        </Button>
      </div>
      {value.length > 0 ? (
        <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <li
              key={tag}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-sm"
            >
              <span>{tag}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(value.filter((t) => t !== tag))}
                aria-label={`Remove tag ${tag}`}
                className="rounded-sm p-0.5 outline-none hover:bg-background focus-visible:ring-3 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
