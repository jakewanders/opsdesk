import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Netlify's CONTEXT (production, deploy-preview, branch-deploy) is a build-time variable and is
  // not guaranteed at runtime, so inline it into the bundle. src/proxy.ts uses it to send
  // `noindex` on non-production deploys; src/lib/env/public.ts uses it for the production-origin check.
  // DEPLOY_PRIME_URL (the deploy's own URL) is inlined the same way: src/lib/api/trusted-origins.ts
  // trusts it for mutations in preview contexts only. It is a public URL, not a secret.
  env: { CONTEXT: process.env.CONTEXT ?? "", DEPLOY_PRIME_URL: process.env.DEPLOY_PRIME_URL ?? "" },
  cacheComponents: true,
  partialPrefetching: true,
  async redirects() {
    // A real 307 for the settings index (a page-level redirect() would stream a 200 inside the shell).
    return [
      { source: "/app/settings", destination: "/app/settings/organization", permanent: false },
    ];
  },
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
