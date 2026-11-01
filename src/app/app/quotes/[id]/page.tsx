import { PlannedPage } from "@/components/shared/planned-page";

export default function QuoteDetailPage() {
  return (
    <PlannedPage
      title="Quote"
      summary="Totals, status, revisions, and PDF export for one quote."
      milestone="M4"
      backHref="/app/quotes"
      backLabel="Back to quotes"
    />
  );
}
