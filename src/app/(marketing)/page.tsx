import type { Metadata } from "next";
import { getAppOrigin, getRepoUrl } from "@/lib/env/links";
import { LandingPage } from "./_components/landing-page";

const DESCRIPTION =
  "Customers, pipeline, quotes, tasks, and insights in one place. A portfolio demonstration with a no-sign-up live demo.";

// Origin comes from NEXT_PUBLIC_APP_URL (never hard-coded); SIT-273 finalizes canonical and OG.
export const metadata: Metadata = {
  metadataBase: getAppOrigin(),
  title: "OpsDesk: a simpler way to run your business",
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    title: "OpsDesk: a simpler way to run your business",
    description: DESCRIPTION,
    url: "/",
    type: "website",
  },
};

// Static: no user data and no Supabase calls at render time (PRD 8.3).
export default function Home() {
  return <LandingPage repoUrl={getRepoUrl()} />;
}
