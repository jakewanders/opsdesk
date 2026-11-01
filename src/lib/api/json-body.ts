import { BadRequestError, UnsupportedMediaTypeError } from "./errors";

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
  // Not declared as JSON: only acceptable if there is nothing in the body.
  const bytes = request.body === null ? 0 : (await request.clone().arrayBuffer()).byteLength;
  if (bytes > 0) throw new UnsupportedMediaTypeError();
}

/**
 * Reads and parses the JSON body. Malformed JSON is a 400. Returns `unknown`: validate it with
 * Zod before use. The size cap is added by the request-protection issue (SIT-181).
 */
export async function readJson(request: Request): Promise<unknown> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new BadRequestError("The request body could not be read.");
  }
  if (text.trim() === "") throw new BadRequestError("The request body is empty.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequestError("The request body is not valid JSON.");
  }
}
