"use client";

import { useId, useState, type KeyboardEvent } from "react";
import type { FieldControlProps } from "@/components/shared/form-field";
import { Input } from "@/components/ui/input";
import { useApiQuery } from "@/lib/api-client/provider";
import { useDebouncedValue } from "@/lib/api-client/use-url-state";
import { cn } from "@/lib/utils";

export type PickerOption = { id: string; label: string; detail?: string | null };

type Props<T> = {
  /** The chosen record's id ("" for none) and its name. */
  value: string;
  label: string;
  onSelect: (choice: { id: string; name: string } | null) => void;
  control: FieldControlProps;
  disabled?: boolean;
  /** The API list the search runs against, for example `/customers`, and the query it always sends. */
  path: string;
  /** Key prefix for the search cache, for example `customer-picker`. */
  cacheKey: string;
  fixedQuery: Record<string, string | number | boolean | undefined>;
  toOption: (item: T) => PickerOption;
  placeholder: string;
  /** Plural noun for the list's name and the announcements, for example `customers`. */
  nouns: { one: string; many: string };
};

/**
 * A searchable picker as an ARIA combobox: type to search the workspace's records through the API's own list endpoint (so
 * only this workspace's rows can ever be offered), Arrow keys move through the results, Enter chooses (and never submits
 * the form), Esc closes, Tab leaves. Editing the text after choosing clears the choice, so the name on screen is always the
 * id that will be sent. Only results for the text currently typed are offered, never the previous query's, so Enter cannot
 * choose a stale entry. The result count is announced politely.
 */
export function EntityPicker<T>({
  value,
  label,
  onSelect,
  control,
  disabled,
  path,
  cacheKey,
  fixedQuery,
  toOption,
  placeholder,
  nouns,
}: Props<T>) {
  const listId = useId();
  const [text, setText] = useState(label);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [typed, setTyped] = useState(false);
  const q = useDebouncedValue(text.trim(), 250);
  const searching = open && (typed || value === "");

  const results = useApiQuery<T[]>([cacheKey, q], path, {
    query: { q: q || undefined, ...fixedQuery },
    enabled: searching,
    keepPrevious: true,
  });
  const current = text.trim() === q && !results.isPlaceholderData;
  const options = searching && current ? (results.data?.data ?? []).map(toOption) : [];
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const choose = (option: PickerOption) => {
    setTyped(false);
    setText(option.label);
    setOpen(false);
    onSelect({ id: option.id, name: option.label });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      else setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter" && open) {
      event.preventDefault(); // never submits the form from here
      const pick = options[active];
      if (pick) choose(pick);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation(); // closes the list, not the dialog around it
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <Input
        {...control}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? optionId(active) : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          setTyped(true);
          setText(event.target.value);
          setActive(0);
          setOpen(true);
          if (value !== "") onSelect(null); // the old choice no longer matches the text
        }}
        onFocus={() => {
          setTyped(value === "");
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={`Matching ${nouns.many}`}
        hidden={!open}
        className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-popover p-1 text-sm shadow-md"
      >
        {options.map((option, i) => (
          <li
            key={option.id}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            // mousedown (not click) so the input does not lose focus and close the list before the choice lands
            onMouseDown={(event) => {
              event.preventDefault();
              choose(option);
            }}
            onMouseEnter={() => setActive(i)}
            className={cn(
              "cursor-pointer rounded-md px-2 py-1.5",
              i === active && "bg-accent text-accent-foreground",
            )}
          >
            <span className="font-medium">{option.label}</span>
            {option.detail ? (
              <span className="text-muted-foreground"> · {option.detail}</span>
            ) : null}
          </li>
        ))}
      </ul>
      <p role="status" className="sr-only">
        {open && current && results.data && !results.isFetching
          ? options.length === 0
            ? `No matching ${nouns.many}.`
            : `${options.length} matching ${options.length === 1 ? nouns.one : nouns.many}.`
          : ""}
      </p>
    </div>
  );
}
