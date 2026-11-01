import { NextResponse, type NextRequest } from "next/server";
import { FLAGGED_ROUTES } from "@/lib/routes";
import { parseFeatureFlags } from "@/lib/env/schema";

/**
 * P2 routes exist only while their feature flag is on. Turning a flag off must give a real
 * 404 status. A page-level notFound() cannot, because the authenticated shell has already
 * started streaming (200) by then, so the check happens here, before rendering.
 */
export function proxy(request: NextRequest) {
  const flags = parseFeatureFlags({
    NEXT_PUBLIC_ENABLE_BILLING: process.env.NEXT_PUBLIC_ENABLE_BILLING,
    NEXT_PUBLIC_ENABLE_INTEGRATIONS: process.env.NEXT_PUBLIC_ENABLE_INTEGRATIONS,
  });
  const { pathname } = request.nextUrl;
  const blocked = FLAGGED_ROUTES.some(
    (route) =>
      !flags[route.flag] && (pathname === route.path || pathname.startsWith(`${route.path}/`)),
  );
  if (blocked) {
    // Rewriting to a path that has no page yields the standard 404 response.
    return NextResponse.rewrite(new URL("/_flag-disabled", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/app/settings/integrations/:path*", "/app/settings/billing/:path*"],
};
