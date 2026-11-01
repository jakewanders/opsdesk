import { PlannedPage } from "@/components/shared/planned-page";

export default function SignupPage() {
  return (
    <PlannedPage
      title="Create an account"
      summary="Register and set up a private workspace for your team."
      milestone="M1"
      backHref="/demo"
      backLabel="Try the live demo"
    />
  );
}
