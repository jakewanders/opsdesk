import { PlannedPage } from "@/components/shared/planned-page";

// Holding page: the real setup form (name, industry, time zone) ships with SIT-209. The route guard
// (src/lib/auth/route-guard.ts) sends signed-in members with no organization here.
export default function SetupPage() {
  return (
    <PlannedPage
      title="Set up your workspace"
      summary="Name your workspace, choose a time zone, and start adding customers."
      milestone="M1"
      backHref="/app"
      backLabel="Back to dashboard"
    />
  );
}
