"use client";

import { EntityPicker } from "@/components/shared/entity-picker";
import type { FieldControlProps } from "@/components/shared/form-field";
import type { CustomerDto } from "@/features/customers/schema";

type Props = {
  value: string;
  label: string;
  onSelect: (customer: { id: string; name: string } | null) => void;
  control: FieldControlProps;
  disabled?: boolean;
};

/** Searchable picker over the workspace's ACTIVE customers (see `EntityPicker`). */
export function CustomerPicker(props: Props) {
  return (
    <EntityPicker<CustomerDto>
      {...props}
      path="/customers"
      cacheKey="customer-picker"
      fixedQuery={{ limit: 8, sort: "display_name", order: "asc", archived: "false" }}
      toOption={(c) => ({ id: c.id, label: c.displayName, detail: c.companyName ?? c.email })}
      placeholder="Search customers by name, company or email"
      nouns={{ one: "customer", many: "customers" }}
    />
  );
}
