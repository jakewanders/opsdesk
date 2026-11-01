import { PlannedPage } from "@/components/shared/planned-page";

export default function NewCustomerPage() {
  return (
    <PlannedPage
      title="New customer"
      summary="Add a customer with contact details, status, and source."
      milestone="M2"
      backHref="/app/customers"
      backLabel="Back to customers"
    />
  );
}
