import { BadRequestError, UnsupportedMediaTypeError } from "./errors";
import { bodyLimitFor, readTextWithLimit } from "./request-guard";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** True for `application/json` and `application/<x>+json`, ignoring charset parameters. */
export function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return mediaType === "application/json" || /^application\/[\w.+-]+\+json$/.test(mediaType);
}

/**
 * A request that carries a body must declare it as JSON; a request with no body (a bare
 * `POST /demo/reset`) is fine. In the Next.js runtime `request.body` is an empty stream, not
 * `null`, for a body-less request, so presence is decided by the actual bytes. The common case
 * (a JSON content type) never reads the body here.
 */
export async function assertJsonRequest(request: Request): Promise<void> {
  if (!BODY_METHODS.has(request.method.toUpperCase())) return;
  if (isJsonContentType(request.headers.get("content-type"))) return;
  if (request.headers.get("content-length") === "0") return;
  // Not declared as JSON: only acceptable if there is nothing in the body. Look at the first
  // non-empty chunk only, so an oversized or endless body is never buffered.
  if (request.body === null) return;
  const reader = request.clone().body?.getReader();
  if (!reader) return;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.byteLength > 0) throw new UnsupportedMediaTypeError();
    }
  } finally {
    // Not awaited: cancelling one branch of a cloned body settles only when the other is cancelled too.
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * Reads and parses the JSON body. Malformed JSON is a 400. Returns `unknown`: validate it with
 * Zod before use. The body is read with a size cap (100 KB by default; `withApi` can raise it
 * per route) and a larger body is a 413 before any parsing.
 */
export async function readJson(request: Request): Promise<unknown> {
  const text = await readTextWithLimit(request, bodyLimitFor(request));
  if (text.trim() === "") throw new BadRequestError("The request body is empty.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequestError("The request body is not valid JSON.");
  }
}
