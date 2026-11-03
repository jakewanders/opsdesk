import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { OrganizationSettings } from "@/features/organizations/components/organization-settings";
import { timeZoneOptions } from "@/features/organizations/form-values";
import { readSettings } from "@/features/organizations/service";
import { getPageOrgContext } from "@/lib/org/page-context";
import { isIanaTimeZone } from "@/lib/domain/timezone";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Organization settings" };

/**
 * /app/settings/organization. Read on the server with the caller's own session. Owners and admins of a real workspace get the form;
 * members, viewers and demo guests get the same values read-only, each with its reason.
 */
export default async function OrganizationSettingsPage() {
  await connection();
  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx, supabase } = page;
  const settings = await readSettings(supabase, ctx.org.id);
  const supported = Intl.supportedValuesOf("timeZone").filter(isIanaTimeZone);
  return (
    <OrganizationSettings
      settings={settings}
      memberRole={ctx.role}
      isDemo={ctx.kind === "demo"}
      canEdit={can(ctx.role, ctx.kind, "org.settings.update").allowed}
      zones={timeZoneOptions(settings.timezone, supported)}
    />
  );
}
