import { PlannedPage } from "@/components/shared/planned-page";
import { PageTransition } from "@/components/layout/page-transition";

export default function BillingSettingsPage() {
  return (
    <PageTransition>
      <PlannedPage
        title="Billing"
        summary="Test-mode subscription checkout."
        milestone="M6"
        backHref="/app"
        backLabel="Back to dashboard"
      />
    </PageTransition>
  );
}
