import type { NextConfig } from "next";
import { buildSecurityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  // The end-to-end run builds into its own directory (scripts/e2e.mjs): its browser bundle bakes in the LOCAL Supabase
  // settings and the e2e origin, which must not leak into the build that the integration tests start.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  /* config options here */
  // Netlify's CONTEXT (production, deploy-preview, branch-deploy) is a build-time variable and is
  // not guaranteed at runtime, so inline it into the bundle. src/proxy.ts uses it to send
  // `noindex` on non-production deploys; src/lib/env/public.ts uses it for the production-origin check.
  // DEPLOY_PRIME_URL (the deploy's own URL) is inlined the same way: src/lib/api/trusted-origins.ts
  // trusts it for mutations in preview contexts only. It is a public URL, not a secret.
  env: { CONTEXT: process.env.CONTEXT ?? "", DEPLOY_PRIME_URL: process.env.DEPLOY_PRIME_URL ?? "" },
  // Netlify gives every deploy an id (DEPLOY_ID at build time). With it set, Next.js tags assets and navigation requests with the deploy,
  // and a page from an older deploy does a full reload on its next navigation instead of mixing old and new code. A form left open across
  // a deploy can still post an action id the new build lacks: the forms and error boundaries handle that (src/lib/auth/stale-action.ts).
  ...(process.env.DEPLOY_ID ? { deploymentId: process.env.DEPLOY_ID } : {}),
  // Security headers on every response, including the CSP that allows only this site, the Supabase project and Turnstile.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: buildSecurityHeaders({
          supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
          production: process.env.NODE_ENV === "production",
        }),
      },
    ];
  },
  cacheComponents: true,
  partialPrefetching: true,
  // The settings index redirect lives in src/proxy.ts: a redirect declared here would answer without the
  // private cache headers that every /app response must carry.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
