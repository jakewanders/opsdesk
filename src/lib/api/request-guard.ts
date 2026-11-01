import { BadRequestError, ForbiddenError, PayloadTooLargeError } from "./errors";

/** Default cap for a JSON body: 100 KB (PRD 5.2 item 10). Routes may raise it, for example the CSV import. */
export const DEFAULT_MAX_BODY_BYTES = 100 * 1024;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isMutation(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** Normalizes a URL to its origin, or null when it is not an http(s) URL. */
export function toOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The origins allowed to send cookie-authenticated mutations: the configured app origin, plus the
 * deploy's own origin in Netlify preview contexts only. Never derived from `Host` or
 * `X-Forwarded-Host`, which a client can set.
 */
export function computeTrustedOrigins(input: {
  appUrl: string;
  context?: string;
  deployPrimeUrl?: string;
}): string[] {
  const origins = new Set<string>();
  const app = toOrigin(input.appUrl);
  if (app) origins.add(app);
  if (input.context === "deploy-preview" || input.context === "branch-deploy") {
    const preview = input.deployPrimeUrl ? toOrigin(input.deployPrimeUrl) : null;
    if (preview?.startsWith("https://")) origins.add(preview);
  }
  return [...origins];
}

const FORBIDDEN_CODE = "ORIGIN_FORBIDDEN";
const forbidden = () =>
  new ForbiddenError(
    "This request did not come from OpsDesk. Reload the page and try again.",
    FORBIDDEN_CODE,
  );

/**
 * CSRF defence for cookie sessions. For any non-safe method:
 * - an `Origin` header must exactly match a trusted origin (the opaque origin `null` never does);
 * - with no `Origin`, the browser's `Sec-Fetch-Site` must say `same-origin` (or `none`, a user-typed
 *   navigation); a missing or cross-site value is refused;
 * - a `Sec-Fetch-Site` of `cross-site` is refused even when `Origin` matches.
 * `Host` and `X-Forwarded-Host` are deliberately ignored.
 */
export function assertTrustedOrigin(request: Request, trustedOrigins: readonly string[]): void {
  if (!isMutation(request.method)) return;
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase() ?? null;
  if (fetchSite === "cross-site") throw forbidden();
  const origin = request.headers.get("origin");
  if (origin !== null) {
    const normalized = origin === "null" ? null : toOrigin(origin);
    if (normalized !== null && normalized === origin && trustedOrigins.includes(normalized)) return;
    throw forbidden();
  }
  if (fetchSite === "same-origin" || fetchSite === "none") return;
  throw forbidden();
}

/** Rejects a declared `Content-Length` over the cap before anything is read. */
export function assertContentLengthWithin(request: Request, maxBytes: number): void {
  const header = request.headers.get("content-length");
  if (header === null) return;
  if (!/^\d+$/.test(header)) throw new BadRequestError("The Content-Length header is not valid.");
  if (Number(header) > maxBytes) throw new PayloadTooLargeError();
}

/**
 * Reads the body as text, stopping as soon as more than `maxBytes` have arrived, so a chunked
 * upload with no Content-Length cannot exhaust memory either.
 */
export async function readTextWithLimit(request: Request, maxBytes: number): Promise<string> {
  assertContentLengthWithin(request, maxBytes);
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof PayloadTooLargeError) throw error;
    throw new BadRequestError("The request body could not be read.");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const bodyLimits = new WeakMap<Request, number>();
export function setBodyLimit(request: Request, maxBytes: number): void {
  bodyLimits.set(request, maxBytes);
}
export function bodyLimitFor(request: Request): number {
  return bodyLimits.get(request) ?? DEFAULT_MAX_BODY_BYTES;
}
