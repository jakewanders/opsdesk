import { okItem } from "@/lib/api/envelope";
import { NotFoundError } from "@/lib/api/errors";
import { withApi, withOrgApi } from "@/lib/api/handler";
import { loadMemberships, selectOrg } from "@/lib/api/org-context";
import { createClient } from "@/lib/supabase/server";
import { updateOrganizationSchema } from "@/features/organizations/schema";
import { updateSettings } from "@/features/organizations/service";
import { parseBody } from "@/lib/validation";

/**
 * GET /api/v1/organizations/:id: a workspace the caller belongs to. A non-member gets 404 (the same answer as
 * for an id that does not exist), a malformed id 400. An expired demo is still readable so the app can say so.
 */
export const GET = withApi<{ id: string }>(async ({ params, user }) => {
  const supabase = await createClient();
  const ctx = selectOrg(user!, await loadMemberships(supabase, user!.id), params.id, {
    allowExpired: true,
  });
  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, industry, timezone, currency, kind, expires_at, created_at, updated_at")
    .eq("id", ctx.org.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError("That workspace was not found.", "ORG_NOT_FOUND");
  const expiry = data.expires_at ? new Date(data.expires_at).getTime() : null;
  return okItem({
    id: data.id,
    name: data.name,
    industry: data.industry,
    timezone: data.timezone,
    currency: data.currency,
    kind: ctx.kind,
    role: ctx.role,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    expiresAt: data.expires_at,
    secondsRemaining:
      ctx.kind === "demo" ? Math.max(0, Math.floor(((expiry ?? 0) - Date.now()) / 1000)) : null,
    expired: ctx.expired,
  });
});

/**
 * PATCH /api/v1/organizations/:id: change the workspace's `name`, `industry` and `timezone` (send the `expectedUpdatedAt` you last saw;
 * a stale one is 409 `STALE_EDIT`). Owner and admin only: a member or viewer gets 403, a demo guest 403. `kind`, `expiresAt`, `currency`
 * and any other field are a 422. The workspace is named by `X-Organization-Id` like every workspace endpoint, and the path must name the
 * same one (otherwise 404). The change is logged server-side with the names of the fields only.
 */
export const PATCH = withOrgApi<{ id: string }>(
  async ({ params, request, supabase, org, log }) => {
    const input = await parseBody(updateOrganizationSchema, request);
    const { settings, changed } = await updateSettings(supabase, org, params.id, input);
    if (changed.length > 0) log.info("org.settings_updated", { fields: changed });
    return okItem(settings);
  },
  { authorize: "org.settings.update" },
);
