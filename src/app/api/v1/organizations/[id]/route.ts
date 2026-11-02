import { okItem } from "@/lib/api/envelope";
import { NotFoundError } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { loadMemberships, selectOrg } from "@/lib/api/org-context";
import { createClient } from "@/lib/supabase/server";

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
    .select("id, name, industry, timezone, currency, kind, expires_at, created_at")
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
    expiresAt: data.expires_at,
    secondsRemaining:
      ctx.kind === "demo" ? Math.max(0, Math.floor(((expiry ?? 0) - Date.now()) / 1000)) : null,
    expired: ctx.expired,
  });
});
