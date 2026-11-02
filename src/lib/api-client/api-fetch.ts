import type { ApiErrorBody, ApiMeta, FieldErrors } from "@/lib/api/types";

/**
 * The one way client code talks to `/api/v1` (PRD 7.1: no competing fetch systems). Returns `{ data, meta }` and
 * throws `ClientApiError`, so a caller (or TanStack Query) deals with one shape of failure.
 */
export type ApiResponse<T> = { data: T; meta: ApiMeta };

export type ApiFetchOptions = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON body. */
  json?: unknown;
  /** Query-string values; `undefined`, `null` and empty strings are left out. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Sent as `X-Organization-Id`. It selects the workspace; the server still checks membership. */
  organizationId?: string | null;
  /** Sent as `Idempotency-Key` (mutations that must not repeat). */
  idempotencyKey?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

/** Codes the client itself makes up (everything else is the server's `error.code`). */
export type ClientErrorCode = "NETWORK_ERROR" | "INVALID_RESPONSE";

/** A failed API call: the server's error envelope, or a network or format failure (`status` 0). */
export class ClientApiError extends Error {
  readonly name = "ClientApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly fieldErrors?: FieldErrors,
    readonly meta?: Record<string, unknown>,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }

  /** The record changed since it was loaded: reload it (`meta.current` has the latest version). */
  get isStaleEdit(): boolean {
    return this.status === 409 && this.code === "STALE_EDIT";
  }
  get isValidation(): boolean {
    return this.status === 422 && this.fieldErrors !== undefined;
  }
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
  /** Worth retrying by itself: the request never got an answer, or the server failed. */
  get isTransient(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export function isClientApiError(error: unknown): error is ClientApiError {
  return error instanceof ClientApiError;
}

const BASE = "/api/v1";

export function buildApiUrl(path: string, query?: ApiFetchOptions["query"]): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new Error(`apiFetch: "${path}" must be a path under ${BASE}`);
  }
  const full = path.startsWith(`${BASE}/`) || path === BASE ? path : `${BASE}${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${full}?${qs}` : full;
}

function isErrorBody(value: unknown): value is { error: ApiErrorBody } {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const e = (value as { error: unknown }).error;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as ApiErrorBody).code === "string" &&
    typeof (e as ApiErrorBody).message === "string"
  );
}

export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<ApiResponse<T>> {
  const { method = "GET", json, query, organizationId, idempotencyKey, signal, headers } = options;
  const requestHeaders: Record<string, string> = { Accept: "application/json", ...headers };
  if (json !== undefined) requestHeaders["Content-Type"] = "application/json";
  if (organizationId) requestHeaders["X-Organization-Id"] = organizationId;
  if (idempotencyKey) requestHeaders["Idempotency-Key"] = idempotencyKey;

  let response: Response;
  try {
    response = await fetch(buildApiUrl(path, query), {
      method,
      headers: requestHeaders,
      body: json === undefined ? undefined : JSON.stringify(json),
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "AbortError") throw error;
    throw new ClientApiError(
      0,
      "NETWORK_ERROR",
      "We could not reach the server. Check your connection and try again.",
    );
  }

  const requestId = response.headers.get("X-Request-Id") ?? undefined;
  if (response.status === 204) return { data: undefined as T, meta: {} };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ClientApiError(
      response.ok ? 0 : response.status,
      "INVALID_RESPONSE",
      "The server sent a response we could not read. Try again.",
      requestId,
    );
  }

  if (!response.ok) {
    if (isErrorBody(body)) {
      const e = body.error;
      const retry = Number(response.headers.get("Retry-After"));
      throw new ClientApiError(
        response.status,
        e.code,
        e.message,
        e.requestId ?? requestId,
        e.fieldErrors,
        e.meta,
        Number.isFinite(retry) && retry > 0 ? retry : undefined,
      );
    }
    throw new ClientApiError(
      response.status,
      "INVALID_RESPONSE",
      "Something went wrong. Try again.",
      requestId,
    );
  }

  if (typeof body !== "object" || body === null || !("data" in body)) {
    throw new ClientApiError(
      0,
      "INVALID_RESPONSE",
      "The server sent a response we could not read. Try again.",
      requestId,
    );
  }
  const { data, meta } = body as { data: T; meta?: ApiMeta };
  return { data, meta: meta ?? {} };
}
