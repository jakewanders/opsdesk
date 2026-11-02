import { ForbiddenError } from "@/lib/api/errors";
import { created, okList } from "@/lib/api/envelope";
import { withApi } from "@/lib/api/handler";
import { loadMemberships } from "@/lib/api/org-context";
import { createOrganizationSchema, toWorkspaces } from "@/lib/api/organizations";
import { createClient } from "@/lib/supabase/server";
import { parseBody } from "@/lib/validation";

/** GET /api/v1/organizations: the caller's workspaces (and only those: RLS hides every other tenant). */
export const GET = withApi(async ({ user }) => {
  const supabase = await createClient();
  const workspaces = toWorkspaces(await loadMemberships(supabase, user!.id));
  return okList(workspaces, { total: workspaces.length });
});

/**
 * POST /api/v1/organizations: create a real workspace through `create_real_organization`, which is the only
 * way to create one. Guests get 403 (also enforced inside the database function); input is validated first (422).
 */
export const POST = withApi(async ({ request, user }) => {
  if (user!.isAnonymous) {
    throw new ForbiddenError(
      "Create an account to keep your data. Guests cannot create workspaces.",
      "ACCOUNT_REQUIRED",
    );
  }
  const input = await parseBody(createOrganizationSchema, request);
  const supabase = await createClient();
  const { data: id, error } = await supabase.rpc("create_real_organization", {
    org_name: input.name,
    org_industry: input.industry ?? undefined,
    org_timezone: input.timezone ?? "UTC",
  });
  if (error) throw error;
  const memberships = await loadMemberships(supabase, user!.id);
  const workspace = toWorkspaces(memberships).find((w) => w.id === id);
  if (!workspace) throw new Error("The new workspace could not be read back.");
  return created(workspace);
});
