import { z } from "zod";
import { optionalSingleLine, singleLine } from "@/lib/validation";
import type { MembershipRow, OrgKind, OrgRole } from "./org-context";

/** Same rule as the database (`private.is_valid_timezone`): `UTC` or an IANA `Area/City` name, no posix/right aliases. */
export function isIanaTimeZone(value: string): boolean {
  if (value === "UTC") return true;
  if (!value.includes("/") || /^(posix|right)\//.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Body of `POST /api/v1/organizations` (US-02). Unknown fields are rejected. */
export const createOrganizationSchema = z.strictObject({
  name: singleLine(80, 2),
  industry: optionalSingleLine(80).optional(),
  timezone: z
    .string({ error: "Choose a time zone." })
    .trim()
    .min(1, "Choose a time zone.")
    .refine(isIanaTimeZone, "Choose a valid time zone, for example America/New_York.")
    .optional(),
});

export type WorkspaceSummary = {
  id: string;
  name: string;
  kind: OrgKind;
  role: OrgRole;
  timezone: string;
  /** Demo workspaces only. */
  expiresAt: string | null;
  /** Demo workspaces only: whole seconds until expiry, never negative. */
  secondsRemaining: number | null;
  expired: boolean;
};

/** Turns the caller's own membership rows into workspace summaries. Rows whose organization RLS hid are dropped. */
export function toWorkspaces(
  rows: readonly MembershipRow[],
  now: Date = new Date(),
): WorkspaceSummary[] {
  const out: WorkspaceSummary[] = [];
  for (const row of rows) {
    const org = row.organizations;
    if (!org) continue;
    const demo = org.kind === "demo";
    const expiry = demo && org.expires_at ? new Date(org.expires_at).getTime() : null;
    const remaining =
      expiry === null
        ? demo
          ? 0
          : null
        : Math.max(0, Math.floor((expiry - now.getTime()) / 1000));
    out.push({
      id: org.id,
      name: org.name,
      kind: demo ? "demo" : "real",
      role: row.role as OrgRole,
      timezone: org.timezone,
      expiresAt: demo ? org.expires_at : null,
      secondsRemaining: remaining,
      expired: demo && remaining === 0,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
