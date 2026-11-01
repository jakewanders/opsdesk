import { PlannedPage } from "@/components/shared/planned-page";

export default function DemoPage() {
  return (
    <PlannedPage
      title="Live demo"
      summary="Open a private workspace filled with fictional data, with no sign-up."
      milestone="M1"
      backHref="/"
      backLabel="Back to home"
    />
  );
}
