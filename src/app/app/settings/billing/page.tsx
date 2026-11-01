import { PlannedPage } from "@/components/shared/planned-page";

export default function BillingSettingsPage() {
  return (
    <PlannedPage
      title="Billing"
      summary="Test-mode subscription checkout."
      milestone="M6"
      backHref="/app"
      backLabel="Back to dashboard"
    />
  );
}
