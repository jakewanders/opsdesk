import { NextResponse, type NextRequest } from "next/server";
import { FLAGGED_ROUTES } from "@/lib/routes";
import { parseFeatureFlags } from "@/lib/env/schema";
import { NOINDEX_VALUE, shouldNoindex } from "@/lib/robots";
import { decideRoute } from "@/lib/auth/route-guard";
import { applyPrivateNoStore, isPrivateRoute } from "@/lib/http/cache-control";
import { resolveWorkspaceState } from "@/lib/auth/workspace-state";
import { ACTIVE_ORG_COOKIE } from "@/lib/org/active-org";
import { needsSession, updateSession } from "@/lib/supabase/middleware";

function withRobots<T extends NextResponse>(response: T, pathname?: string): T {
  // Anything that can depend on the session is never cached, including redirects and flag 404s.
  if (pathname !== undefined && isPrivateRoute(pathname)) applyPrivateNoStore(response);
  if (shouldNoindex(process.env.CONTEXT)) {
    // Previews and branch deploys must never be indexed; only the production context may be.
    response.headers.set("X-Robots-Tag", NOINDEX_VALUE);
  }
  return response;
}

/**
 * 1. P2 routes exist only while their feature flag is on. Turning a flag off must give a real
 *    404 status. A page-level notFound() cannot, because the authenticated shell has already
 *    started streaming (200) by then, so the check happens here, before rendering.
 * 2. Routes that use the session refresh it here (`updateSession`) and forward the new cookies.
 *    Static public pages are skipped so they stay cacheable.
 *    The same pass applies the routing rules of PRD 3.3 (`decideRoute`): sign-in required for `/app`,
 *    org setup, expired demos, and signed-in users bounced off `/login` and `/signup`.
 * 3. Non-production deploys send `X-Robots-Tag: noindex, nofollow` on every response.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const flagged = FLAGGED_ROUTES.some(
    (route) => pathname === route.path || pathname.startsWith(`${route.path}/`),
  );
  if (flagged) {
    const flags = parseFeatureFlags({
      NEXT_PUBLIC_ENABLE_BILLING: process.env.NEXT_PUBLIC_ENABLE_BILLING,
      NEXT_PUBLIC_ENABLE_INTEGRATIONS: process.env.NEXT_PUBLIC_ENABLE_INTEGRATIONS,
    });
    const blocked = FLAGGED_ROUTES.some(
      (route) =>
        !flags[route.flag] && (pathname === route.path || pathname.startsWith(`${route.path}/`)),
    );
    if (blocked) {
      // Rewriting to a path that has no page yields the standard 404 response.
      return withRobots(NextResponse.rewrite(new URL("/_flag-disabled", request.url)), pathname);
    }
  }
  if (needsSession(pathname)) {
    const { response, user, supabase } = await updateSession(request);
    const redirectTo = await decideRoute({
      pathname,
      search: request.nextUrl.search,
      user,
      workspace: () =>
        user
          ? resolveWorkspaceState(
              supabase,
              user.id,
              new Date(),
              request.cookies.get(ACTIVE_ORG_COOKIE)?.value ?? null,
            )
          : Promise.resolve("unknown"),
    });
    if (redirectTo) {
      const target = request.nextUrl.clone();
      const [path, query = ""] = redirectTo.split("?");
      target.pathname = path;
      target.search = query ? `?${query}` : "";
      const redirect = NextResponse.redirect(target, 307);
      // Keep the refreshed session cookies and their cache headers on the redirect.
      for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
      for (const name of ["cache-control", "expires", "pragma"]) {
        const value = response.headers.get(name);
        if (value) redirect.headers.set(name, value);
      }
      return withRobots(redirect, pathname);
    }
    // A real 307 for the settings index (a page-level redirect() would stream a 200 inside the shell).
    if (pathname === "/app/settings") {
      const target = request.nextUrl.clone();
      target.pathname = "/app/settings/organization";
      const redirect = NextResponse.redirect(target, 307);
      for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
      return withRobots(redirect, pathname);
    }
    return withRobots(response, pathname);
  }
  return withRobots(NextResponse.next(), pathname);
}

export const config = {
  // Every page and API route; static assets and image optimization are excluded.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
