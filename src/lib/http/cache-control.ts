/**
 * The only cache policy for anything that can contain, or depend on, a user's session (PRD 5.2 item 7):
 * `private` stops shared caches (CDN, proxy) from storing it, `no-store` stops every cache from reusing it.
 */
export const PRIVATE_NO_STORE = "private, no-store";

/**
 * True when the response may depend on who is asking: `/app/*`, `/demo`, the auth pages and callbacks, `/api/*`.
 * The same list decides which routes refresh the session (src/proxy.ts) and which get the private policy. The
 * static landing and legal pages are left out so they stay cacheable and never carry a Set-Cookie header.
 */
export function isPrivateRoute(pathname: string): boolean {
  return (
    pathname === "/app" ||
    pathname.startsWith("/app/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/api/") ||
    ["/demo", "/login", "/signup", "/forgot-password", "/reset-password"].includes(pathname)
  );
}

/** Applies the private policy. Never loosens a stricter policy Next.js already set. */
export function applyPrivateNoStore<T extends Response>(response: T): T {
  const existing = response.headers.get("cache-control") ?? "";
  const alreadyStrict = /\bprivate\b/i.test(existing) && /\bno-store\b/i.test(existing);
  if (!alreadyStrict) response.headers.set("Cache-Control", PRIVATE_NO_STORE);
  // Auth responses vary by cookie; say so for any cache that ignores no-store.
  const vary = response.headers.get("vary") ?? "";
  if (!/\bcookie\b/i.test(vary)) response.headers.append("Vary", "Cookie");
  return response;
}
