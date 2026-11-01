import { PlannedPage } from "@/components/shared/planned-page";

export default function IntegrationsSettingsPage() {
  return (
    <PlannedPage
      title="Integrations"
      summary="Connect an external CRM or webhook."
      milestone="M6"
      backHref="/app"
      backLabel="Back to dashboard"
    />
  );
}
