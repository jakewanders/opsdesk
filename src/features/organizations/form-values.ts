import type { FieldErrors, Resolver } from "react-hook-form";
import { updateOrganizationSchema, type OrganizationSettingsDto } from "./schema";

export type SettingsFormValues = { name: string; industry: string; timezone: string };
export const FIELD_ORDER = ["name", "industry", "timezone"] as const;

export const toFormValues = (
  s: Pick<OrganizationSettingsDto, "name" | "industry" | "timezone">,
): SettingsFormValues => ({
  name: s.name,
  industry: s.industry ?? "",
  timezone: s.timezone,
});

// The editable part of the API's schema, so the form and the endpoint give the same messages.
const editable = updateOrganizationSchema.omit({ expectedUpdatedAt: true });

export const settingsResolver: Resolver<SettingsFormValues> = async (values) => {
  const result = editable.safeParse(values);
  if (result.success) return { values, errors: {} };
  const errors: Record<string, { type: string; message: string }> = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? "");
    errors[field] ??= { type: "validation", message: issue.message };
  }
  return { values: {}, errors: errors as FieldErrors<SettingsFormValues> };
};

/** The request body: blank industry clears it. */
export const toPayload = (values: SettingsFormValues) => editable.parse(values);

/** Every IANA zone this runtime knows, plus UTC and the zone in use, sorted. */
export function timeZoneOptions(current: string, supported: readonly string[]): string[] {
  return [...new Set(["UTC", current, ...supported])].sort((a, b) => a.localeCompare(b));
}
