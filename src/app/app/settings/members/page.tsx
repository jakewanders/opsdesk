import { PlannedPage } from "@/components/shared/planned-page";

export default function MembersSettingsPage() {
  return (
    <PlannedPage
      title="Members"
      summary="Invite people, change roles, and remove members."
      milestone="M4"
      backHref="/app"
      backLabel="Back to dashboard"
    />
  );
}
