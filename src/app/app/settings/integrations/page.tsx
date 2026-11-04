import { PlannedPage } from "@/components/shared/planned-page";
import { PageTransition } from "@/components/layout/page-transition";

export default function IntegrationsSettingsPage() {
  return (
    <PageTransition>
      <PlannedPage
        title="Integrations"
        summary="Connect an external CRM or webhook."
        milestone="M6"
        backHref="/app"
        backLabel="Back to dashboard"
      />
    </PageTransition>
  );
}
