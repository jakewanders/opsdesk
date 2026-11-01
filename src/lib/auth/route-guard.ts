import { DEFAULT_AFTER_LOGIN, safeNextPath } from "./safe-redirect";

/** Where a signed-in user with no workspace creates one (the page ships with SIT-209). */
export const ORG_SETUP_PATH = "/app/setup";
export const DEMO_PATH = "/demo";
export const LOGIN_PATH = "/login";

/**
 * What the database says about the signed-in user's workspaces:
 * - `ready`: at least one usable workspace;
 * - `none`: no membership at all;
 * - `expired-demo`: only demo workspaces, all past their expiry;
 * - `unknown`: could not be determined (query refused or failed). Routing then does not redirect:
 *   this layer only routes, and every handler and RLS policy still authorizes on its own.
 */
export type WorkspaceState = "ready" | "none" | "expired-demo" | "unknown";

export type GuardUser = { isAnonymous: boolean } | null;

export type GuardInput = {
  pathname: string;
  search: string;
  user: GuardUser;
  /** Looked up lazily, only for `/app` routes with a signed-in user. */
  workspace: () => Promise<WorkspaceState>;
};

const isApp = (p: string) => p === "/app" || p.startsWith("/app/");

/**
 * The routing rules of PRD 3.3. Returns the path to redirect to (relative, with any query), or `null`
 * to let the request through. Every rule here is a *routing* convenience; none replaces authorization.
 *
 * 1. Signed-out visitor on `/app/*`            -> `/login?next=<validated path>`
 * 2. Signed-in member on `/login` or `/signup` -> the validated `next`, else `/app`
 *    (a demo guest may still open them, to create a real account)
 * 3. `/app/*` with no workspace                -> a member goes to org setup, a guest to `/demo`
 * 4. `/app/*` for a guest whose demo expired   -> `/demo`
 *
 * No loop is possible: `/login`, `/signup`, `/demo` and the setup page never redirect to an `/app` path
 * that redirects back (see the fixpoint test), and `/demo` is never redirected away from.
 */
export async function decideRoute(input: GuardInput): Promise<string | null> {
  const { pathname, search, user } = input;

  if (pathname === "/login" || pathname === "/signup") {
    if (user && !user.isAnonymous) {
      const next = new URLSearchParams(search).get("next");
      return safeNextPath(next, DEFAULT_AFTER_LOGIN);
    }
    return null;
  }

  if (!isApp(pathname)) return null;

  if (!user) {
    const target = safeNextPath(`${pathname}${search}`);
    return `${LOGIN_PATH}?next=${encodeURIComponent(target)}`;
  }

  const state = await input.workspace();
  if (state === "expired-demo") return DEMO_PATH;
  if (state === "none") {
    if (user.isAnonymous) return DEMO_PATH;
    return pathname === ORG_SETUP_PATH ? null : ORG_SETUP_PATH;
  }
  return null;
}
