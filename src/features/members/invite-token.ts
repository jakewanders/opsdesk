/**
 * The invitation token travels in the URL fragment (`/invite#token=...`), so it never reaches a server, a proxy log or a
 * `Referer`. The page reads it once, removes it from the address bar, and keeps it only in memory, except for the trip to the
 * sign-in or sign-up page and back, where it waits in sessionStorage (this tab only) until it is read once and deleted.
 */
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const KEY = "opsdesk.invite";

/** The token in a `#token=...` fragment, or null when it is absent or not in the canonical shape. */
export function tokenFromHash(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return value && TOKEN_PATTERN.test(value) ? value : null;
}

export function stashToken(token: string): void {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    /* storage can be blocked: the person then opens the link again after signing in */
  }
}

/** Reads and deletes the stashed token. */
export function takeStashedToken(): string | null {
  try {
    const value = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return value && TOKEN_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearStashedToken(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
