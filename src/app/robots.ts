import type { MetadataRoute } from "next";
import { getAppOrigin } from "@/lib/env/links";
import { shouldNoindex } from "@/lib/robots";

/**
 * robots.txt (SIT-273): built from the configured origin, never from the Host header. Only the production context may be indexed; previews
 * and branch deploys disallow everything (they also send `X-Robots-Tag: noindex`). In production the public pages are open and the
 * application, the account pages, the API and the demo entry (a crawler would only start guest sessions) are not.
 */
export default function robots(): MetadataRoute.Robots {
  const origin = getAppOrigin().origin;
  if (shouldNoindex(process.env.CONTEXT)) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/app",
        "/api/",
        "/auth/",
        "/demo",
        "/login",
        "/signup",
        "/forgot-password",
        "/reset-password",
        "/invite",
      ],
    },
    sitemap: `${origin}/sitemap.xml`,
  };
}
