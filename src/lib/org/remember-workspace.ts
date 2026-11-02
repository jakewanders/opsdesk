import { cookies } from "next/headers";
import { getAppOrigin } from "@/lib/env/links";
import { ACTIVE_ORG_COOKIE } from "./active-org";

/** Stores the active-workspace UI preference. It is re-verified against memberships on every request. */
export async function rememberWorkspace(id: string): Promise<void> {
  (await cookies()).set(ACTIVE_ORG_COOKIE, id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: getAppOrigin().protocol === "https:",
    maxAge: 365 * 24 * 60 * 60,
  });
}
