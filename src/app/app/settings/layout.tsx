import type { ReactNode } from "react";
import { SettingsNav, type SettingsLink } from "@/components/layout/settings-nav";
import { getFeatureFlags } from "@/lib/env/public";

export default function SettingsLayout({ children }: { children: ReactNode }) {
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
      {children}
    </div>
  );
}
