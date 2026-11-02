import "server-only";
import { connection } from "next/server";
import { createClient } from "./server";
import { resolveUser, type CurrentUser } from "./resolve-user";

export type { CurrentUser };

/** The verified current user for this request, or null when signed out. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  // Reading the session reads the clock; say first that this is request-time work, so a prerender pass never tries to do it
  // (Next logged "unstable value Date.now() while prerendering" for /signup and /demo).
  await connection();
  return resolveUser(await createClient());
}
