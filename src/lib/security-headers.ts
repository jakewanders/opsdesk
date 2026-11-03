/**
 * Security response headers for every route (SIT-272, PRD 10.2). One place, tested, and built from the environment so a preview that talks
 * to the test Supabase project allows that project and not the production one.
 *
 * Content-Security-Policy, in plain words:
 * - scripts come from this site and from Cloudflare Turnstile (the sign-in security check); inline scripts are allowed because Next.js
 *   writes its own small inline bootstrap script and the theme script before first paint (nonce-based CSP would make every page
 *   per-request dynamic and end static caching of the public pages, so it is not used);
 * - the browser may call this site, the Supabase project and Turnstile, and nothing else;
 * - nothing may frame the site, embed it as an object, or change its base URL, and forms post only to the site itself.
 * Development is left without a CSP (the dev server needs eval and websockets).
 */
const TURNSTILE = "https://challenges.cloudflare.com";

export type SecurityHeader = { key: string; value: string };

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function buildContentSecurityPolicy(options: { supabaseUrl?: string; production: boolean }) {
  const supabase = originOf(options.supabaseUrl);
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", "'unsafe-inline'", TURNSTILE]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", ["'self'", ...(supabase ? [supabase] : []), TURNSTILE]],
    ["frame-src", [TURNSTILE]],
    ["frame-ancestors", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["object-src", ["'none'"]],
  ];
  if (options.production) directives.push(["upgrade-insecure-requests", []]);
  return directives.map(([name, values]) => [name, ...values].join(" ")).join("; ");
}

export function buildSecurityHeaders(options: {
  supabaseUrl?: string;
  production: boolean;
}): SecurityHeader[] {
  const headers: SecurityHeader[] = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=(), interest-cohort=()",
    },
  ];
  if (options.production) {
    headers.push({ key: "Content-Security-Policy", value: buildContentSecurityPolicy(options) });
  }
  return headers;
}
