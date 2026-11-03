import { z } from "zod";
import { expectedUpdatedAtField } from "@/lib/api/concurrency";
import { isIanaTimeZone } from "@/lib/domain/timezone";
import { optionalSingleLine, singleLine } from "@/lib/validation";

/** The IANA time zone rule of the database (`private.is_valid_timezone`). */
export const timeZoneField = () =>
  z
    .string({ error: "Choose a time zone." })
    .trim()
    .min(1, "Choose a time zone.")
    .refine(isIanaTimeZone, "Choose a valid time zone, for example America/New_York.");

/**
 * Body of PATCH /api/v1/organizations/:id (US-09): the workspace's name, industry and time zone, plus the `updatedAt` last seen.
 * Every settings field is optional (absent = unchanged; a blank industry clears it). The schema is strict, so `kind`, `expiresAt`,
 * `currency`, `slug` and any other field are a 422: those are never writable from here.
 */
export const updateOrganizationSchema = z.strictObject({
  ...expectedUpdatedAtField,
  name: singleLine(80, 2).optional(),
  industry: optionalSingleLine(80).optional(),
  timezone: timeZoneField().optional(),
});
export type UpdateOrganizationInput = z.output<typeof updateOrganizationSchema>;

/** The settings as the API returns them after a change. */
export type OrganizationSettingsDto = {
  id: string;
  name: string;
  industry: string | null;
  timezone: string;
  updatedAt: string;
};
