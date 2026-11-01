import { NextResponse, type NextRequest } from "next/server";
import { FLAGGED_ROUTES } from "@/lib/routes";
import { parseFeatureFlags } from "@/lib/env/schema";
import { NOINDEX_VALUE, shouldNoindex } from "@/lib/robots";

function withRobots<T extends NextResponse>(response: T): T {
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
 * 2. Non-production deploys send `X-Robots-Tag: noindex, nofollow` on every response.
 */
export function proxy(request: NextRequest) {
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
      return withRobots(NextResponse.rewrite(new URL("/_flag-disabled", request.url)));
    }
  }
  return withRobots(NextResponse.next());
}

export const config = {
  // Every page and API route; static assets and image optimization are excluded.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
