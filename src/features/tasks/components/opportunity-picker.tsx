"use client";

import { EntityPicker } from "@/components/shared/entity-picker";
import type { FieldControlProps } from "@/components/shared/form-field";
import type { OpportunityDto } from "@/features/opportunities/schema";

type Props = {
  value: string;
  label: string;
  onSelect: (opportunity: { id: string; name: string } | null) => void;
  control: FieldControlProps;
  disabled?: boolean;
};

/** Searchable picker over the workspace's ACTIVE opportunities, by deal title or customer name (see `EntityPicker`). */
export function OpportunityPicker(props: Props) {
  return (
    <EntityPicker<OpportunityDto>
      {...props}
      path="/opportunities"
      cacheKey="opportunity-picker"
      fixedQuery={{ limit: 8, sort: "title", order: "asc", archived: "false" }}
      toOption={(o) => ({ id: o.id, label: o.title, detail: o.customerName })}
      placeholder="Search opportunities by title or customer"
      nouns={{ one: "opportunity", many: "opportunities" }}
    />
  );
}
