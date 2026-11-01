import { PlannedPage } from "@/components/shared/planned-page";

export default function ResetPasswordPage() {
  return (
    <PlannedPage
      title="Choose a new password"
      summary="Set a new password after following the link in your email."
      milestone="M1"
      backHref="/login"
      backLabel="Back to log in"
    />
  );
}
