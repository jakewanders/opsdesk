import { PlannedPage } from "@/components/shared/planned-page";

export default function OrganizationSettingsPage() {
  return (
    <PlannedPage
      title="Organization settings"
      summary="Workspace name, industry, and time zone."
      milestone="M4"
      backHref="/app"
      backLabel="Back to dashboard"
    />
  );
}
