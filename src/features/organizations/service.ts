import type { SupabaseClient } from "@supabase/supabase-js";
import { StaleEditError, updateIfCurrent } from "@/lib/api/concurrency";
import { NotFoundError } from "@/lib/api/errors";
import type { OrgContext } from "@/lib/api/org-context";
import { assertCan } from "@/lib/permissions";
import type { Database } from "@/lib/supabase/database.types";
import type { OrganizationSettingsDto, UpdateOrganizationInput } from "./schema";

type Client = SupabaseClient<Database>;
type Row = {
  id: string;
  name: string;
  industry: string | null;
  timezone: string;
  updated_at: string;
};

const COLUMNS = "id, name, industry, timezone, updated_at";
const toDto = (row: Row): OrganizationSettingsDto => ({
  id: row.id,
  name: row.name,
  industry: row.industry,
  timezone: row.timezone,
  updatedAt: row.updated_at,
});

/** The workspace's editable settings (members read them; RLS decides). */
export async function readSettings(
  supabase: Client,
  orgId: string,
): Promise<OrganizationSettingsDto> {
  const { data, error } = await supabase
    .from("organizations")
    .select(COLUMNS)
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError("That workspace was not found.", "ORG_NOT_FOUND");
  return toDto(data as Row);
}

/**
 * Changes the workspace's name, industry and time zone. Owner and admin only (the permission module; the database's update policy
 * and its column grant are the final authority, and refuse a guest). `updatedAt` must be what the caller last saw: a stale one is a
 * 409 `STALE_EDIT` and nothing changes. A patch that changes nothing is a 200 that writes nothing.
 * Returns the settings and the names of the fields that changed (never their values) for the log.
 */
export async function updateSettings(
  supabase: Client,
  ctx: OrgContext,
  orgId: string,
  input: UpdateOrganizationInput,
): Promise<{ settings: OrganizationSettingsDto; changed: string[] }> {
  assertCan(ctx.role, ctx.kind, "org.settings.update");
  if (orgId !== ctx.org.id)
    throw new NotFoundError("That workspace was not found.", "ORG_NOT_FOUND");
  const { expectedUpdatedAt, ...patch } = input;
  const current = await readSettings(supabase, orgId);
  if (current.updatedAt !== expectedUpdatedAt)
    throw new StaleEditError({ updatedAt: current.updatedAt });

  const columns: Record<string, unknown> = {};
  if (patch.name !== undefined && patch.name !== current.name) columns.name = patch.name;
  if (patch.industry !== undefined && patch.industry !== current.industry)
    columns.industry = patch.industry;
  if (patch.timezone !== undefined && patch.timezone !== current.timezone)
    columns.timezone = patch.timezone;
  const changed = Object.keys(columns);
  if (changed.length === 0) return { settings: current, changed };

  const row = (await updateIfCurrent(supabase, {
    table: "organizations",
    id: orgId,
    expected: { updatedAt: expectedUpdatedAt },
    patch: columns,
    columns: COLUMNS,
  })) as Row;
  return { settings: toDto(row), changed };
}
