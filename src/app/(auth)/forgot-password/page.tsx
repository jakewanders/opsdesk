import { PlannedPage } from "@/components/shared/planned-page";

export default function ForgotPasswordPage() {
  return (
    <PlannedPage
      title="Reset your password"
      summary="Request a link to choose a new password."
      milestone="M1"
      backHref="/login"
      backLabel="Back to log in"
    />
  );
}
