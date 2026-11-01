import { PlannedPage } from "@/components/shared/planned-page";

export default function LoginPage() {
  return (
    <PlannedPage
      title="Log in"
      summary="Sign in to your workspace with email and password."
      milestone="M1"
      backHref="/demo"
      backLabel="Try the live demo"
    />
  );
}
