"use client";

import { useId, useState, type KeyboardEvent } from "react";
import type { FieldControlProps } from "@/components/shared/form-field";
import { Input } from "@/components/ui/input";
import { useApiQuery } from "@/lib/api-client/provider";
import { useDebouncedValue } from "@/lib/api-client/use-url-state";
import type { CustomerDto } from "@/features/customers/schema";
import { cn } from "@/lib/utils";

type Props = {
  /** The chosen customer's id ("" for none) and name. */
  value: string;
  label: string;
  onSelect: (customer: { id: string; name: string } | null) => void;
  control: FieldControlProps;
  disabled?: boolean;
};

/**
 * A searchable customer picker as an ARIA combobox: type to search the workspace's ACTIVE customers (the API's own
 * search, so only this workspace's rows can ever be offered), Arrow keys move through the results, Enter chooses, Esc
 * closes, Tab leaves. Editing the text after choosing clears the choice, so a name on screen is always the customer
 * that will be sent. The result count is announced politely.
 */
export function CustomerPicker({ value, label, onSelect, control, disabled }: Props) {
  const listId = useId();
  const [text, setText] = useState(label);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [typed, setTyped] = useState(false);
  const q = useDebouncedValue(text.trim(), 250);
  const searching = open && (typed || value === "");

  const results = useApiQuery<CustomerDto[]>(["customer-picker", q], "/customers", {
    query: { q: q || undefined, limit: 8, sort: "display_name", order: "asc", archived: "false" },
    enabled: searching,
    keepPrevious: true,
  });
  // Only results for the text that is in the box now: while a new search is pending the old list is not offered, so Enter
  // can never choose an entry that no longer matches what was typed.
  const current = text.trim() === q && !results.isPlaceholderData;
  const options = searching && current ? (results.data?.data ?? []) : [];
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const choose = (customer: CustomerDto) => {
    setTyped(false);
    setText(customer.displayName);
    setOpen(false);
    onSelect({ id: customer.id, name: customer.displayName });
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
        placeholder="Search customers by name, company or email"
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
        aria-label="Matching customers"
        hidden={!open}
        className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-popover p-1 text-sm shadow-md"
      >
        {options.map((customer, i) => (
          <li
            key={customer.id}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            // mousedown (not click) so the input does not lose focus and close the list before the choice lands
            onMouseDown={(event) => {
              event.preventDefault();
              choose(customer);
            }}
            onMouseEnter={() => setActive(i)}
            className={cn(
              "cursor-pointer rounded-md px-2 py-1.5",
              i === active && "bg-accent text-accent-foreground",
            )}
          >
            <span className="font-medium">{customer.displayName}</span>
            {customer.companyName || customer.email ? (
              <span className="text-muted-foreground">
                {" "}
                · {customer.companyName ?? customer.email}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p role="status" className="sr-only">
        {open && current && results.data && !results.isFetching
          ? options.length === 0
            ? "No matching customers."
            : `${options.length} matching ${options.length === 1 ? "customer" : "customers"}.`
          : ""}
      </p>
    </div>
  );
}
