import type { FieldErrors, Resolver } from "react-hook-form";
import { createCustomerSchema, type CustomerDto, type CreateCustomerInput } from "./schema";

/**
 * What the form edits: every control holds text (or the tag list). The shared Zod schema decides what is valid and how
 * it is normalized (trim, lower-case e-mail, http/https website, blank to null), so the browser and the API apply
 * exactly the same rules.
 */
export type CustomerFormValues = {
  type: CustomerDto["type"];
  displayName: string;
  companyName: string;
  email: string;
  phone: string;
  website: string;
  status: CustomerDto["status"];
  source: CustomerDto["source"];
  tags: string[];
  notes: string;
  assignedTo: string;
};

export const EMPTY_CUSTOMER: CustomerFormValues = {
  type: "person",
  displayName: "",
  companyName: "",
  email: "",
  phone: "",
  website: "",
  status: "lead",
  source: "other",
  tags: [],
  notes: "",
  assignedTo: "",
};

export function toFormValues(customer: CustomerDto): CustomerFormValues {
  return {
    type: customer.type,
    displayName: customer.displayName,
    companyName: customer.companyName ?? "",
    email: customer.email ?? "",
    phone: customer.phone ?? "",
    website: customer.website ?? "",
    status: customer.status,
    source: customer.source,
    tags: customer.tags,
    notes: customer.notes ?? "",
    assignedTo: customer.assignedTo ?? "",
  };
}

/** The fields in the order they appear, for the error summary. */
export const FIELD_ORDER = [
  "type",
  "displayName",
  "companyName",
  "email",
  "phone",
  "website",
  "status",
  "source",
  "tags",
  "notes",
  "assignedTo",
] as const satisfies ReadonlyArray<keyof CustomerFormValues>;

/** `tags.2` and `tags` are the same control. */
export const fieldOfPath = (path: string): string => path.split(".")[0] ?? path;

/** Validates with the API's own schema; the first message per field wins (the API gives the same text). */
export const customerResolver: Resolver<CustomerFormValues> = async (values) => {
  const result = createCustomerSchema.safeParse(values);
  if (result.success) return { values, errors: {} };
  const errors: Record<string, { type: string; message: string }> = {};
  for (const issue of result.error.issues) {
    const field = fieldOfPath(issue.path.map(String).join("."));
    errors[field] ??= { type: "validation", message: issue.message };
  }
  return { values: {}, errors: errors as FieldErrors<CustomerFormValues> };
};

/** The normalized request body (throws if the values are invalid; the resolver has already refused those). */
export function toPayload(values: CustomerFormValues): CreateCustomerInput {
  return createCustomerSchema.parse(values);
}
