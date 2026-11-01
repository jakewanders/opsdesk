import { PlannedPage } from "@/components/shared/planned-page";

export default function OpportunityDetailPage() {
  return (
    <PlannedPage
      title="Opportunity"
      summary="Stage, amount, owner, and history for one opportunity."
      milestone="M2"
      backHref="/app/opportunities"
      backLabel="Back to pipeline"
    />
  );
}
