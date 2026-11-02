import { connection } from "next/server";
import type { ReactNode } from "react";
import { GuestSettingsNotice } from "@/components/demo/guest-settings-notice";
import { getCurrentUser } from "@/lib/supabase/current-user";
import { SettingsNav, type SettingsLink } from "@/components/layout/settings-nav";
import { getFeatureFlags } from "@/lib/env/public";

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  await connection();
  const user = await getCurrentUser();
  const flags = getFeatureFlags();
  const links: SettingsLink[] = [
    { href: "/app/settings/organization", label: "Organization" },
    { href: "/app/settings/members", label: "Members" },
    // P2 pages are linked only while their flag is on (the proxy also 404s them when off).
    ...(flags.integrations ? [{ href: "/app/settings/integrations", label: "Integrations" }] : []),
    ...(flags.billing ? [{ href: "/app/settings/billing", label: "Billing" }] : []),
  ];
  return (
    <div className="max-w-3xl">
      <SettingsNav links={links} />
      {user?.isAnonymous ? <GuestSettingsNotice /> : null}
      {children}
    </div>
  );
}
