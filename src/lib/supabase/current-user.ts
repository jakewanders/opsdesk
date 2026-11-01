import "server-only";
import { createClient } from "./server";
import { resolveUser, type CurrentUser } from "./resolve-user";

export type { CurrentUser };

/** The verified current user for this request, or null when signed out. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  return resolveUser(await createClient());
}
