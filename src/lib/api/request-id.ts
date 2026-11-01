/** Name of the header that carries the request ID, in both directions. */
export const REQUEST_ID_HEADER = "x-request-id";

// Letters, digits, dash and underscore, 8 to 64 chars. Anything else (spaces, newlines, quotes)
// could forge or break log lines, so it is replaced rather than echoed.
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The request ID for a request: the caller's `X-Request-Id` when it has a safe shape (so a
 * client or an upstream proxy can correlate), otherwise a fresh UUID.
 */
export function resolveRequestId(headers: Headers): string {
  const supplied = headers.get(REQUEST_ID_HEADER);
  return supplied !== null && SAFE_ID.test(supplied) ? supplied : crypto.randomUUID();
}
