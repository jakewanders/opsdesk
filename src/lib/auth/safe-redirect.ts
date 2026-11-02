export const DEFAULT_AFTER_LOGIN = "/app";

/** Public pages that are valid places to return to after signing in (the invitation page reads its token on the client). */
const ALWAYS_ALLOWED = ["/invite"] as const;

/**
 * Validates a post-login `next` target. Only a same-site path inside the app is accepted: it must
 * start with a single `/`, contain no backslash, control character or encoded slash tricks, and
 * resolve to `/app` or below on a throwaway origin. Anything else (an absolute URL, `//evil.test`,
 * `/\\evil.test`, `javascript:`, a path outside `/app`) returns the fallback, so an open-redirect
 * attempt just lands on the dashboard.
 */
export function safeNextPath(
  value: unknown,
  fallback: string = DEFAULT_AFTER_LOGIN,
  /** Exact extra paths (no query) that may also be targets, for example `/reset-password` from the email callback. */
  extraPaths: readonly string[] = [],
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  // Backslashes are treated as slashes by browsers; control characters and whitespace are never valid.
  if (/[\\\u0000- \u007f-\u009f]/u.test(value)) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(value, "http://opsdesk.invalid");
  } catch {
    return fallback;
  }
  if (parsed.origin !== "http://opsdesk.invalid") return fallback;
  // Percent-decoded dot segments or doubled slashes must not escape /app after normalization.
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return fallback;
  }
  if (decoded.includes("\\") || decoded.includes("//") || decoded.split("/").includes("..")) {
    return fallback;
  }
  const inApp = parsed.pathname === "/app" || parsed.pathname.startsWith("/app/");
  if (
    !inApp &&
    !extraPaths.includes(parsed.pathname) &&
    !(ALWAYS_ALLOWED as readonly string[]).includes(parsed.pathname)
  )
    return fallback;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
