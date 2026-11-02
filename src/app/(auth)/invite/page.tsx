import type { Metadata } from "next";
import { AcceptInvite, type Viewer } from "@/features/members/components/accept-invite";
import { getCurrentUser } from "@/lib/supabase/current-user";

export const metadata: Metadata = {
  title: "Workspace invitation",
  // The link carries a secret in its fragment: keep the page out of search results and do not send a referrer from it.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** /invite#token=... : the page an invitation link opens. The server only says who is looking; the token never reaches it. */
export default async function InvitePage() {
  const user = await getCurrentUser();
  const viewer: Viewer = !user
    ? { kind: "signed-out" }
    : user.isAnonymous
      ? { kind: "guest" }
      : { kind: "member", email: user.email };
  return <AcceptInvite viewer={viewer} />;
}
