import { PlannedPage } from "@/components/shared/planned-page";

export default function CustomerDetailPage() {
  return (
    <PlannedPage
      title="Customer"
      summary="Overview, related opportunities and tasks, and the activity timeline for one customer."
      milestone="M2"
      backHref="/app/customers"
      backLabel="Back to customers"
    />
  );
}
