import { PlannedPage } from "@/components/shared/planned-page";

export default function NewQuotePage() {
  return (
    <PlannedPage
      title="New quote"
      summary="Create a quote for a customer with line items, discount, and tax."
      milestone="M4"
      backHref="/app/quotes"
      backLabel="Back to quotes"
    />
  );
}
