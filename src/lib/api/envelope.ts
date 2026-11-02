import { PRIVATE_NO_STORE } from "@/lib/http/cache-control";
import { ApiError, InternalError } from "./errors";
import type { ApiErrorResponse, ApiMeta, ApiSuccess } from "./types";

/**
 * What a handler returns. Build it with `okItem`, `okList`, `created`, or `noContent` so the
 * shape of `data` cannot drift: an item endpoint always returns an object, a list endpoint
 * always returns an array.
 */
export type ApiResult = {
  readonly __apiResult: true;
  status: 200 | 201 | 204;
  body?: ApiSuccess<unknown>;
};

function result(status: ApiResult["status"], body?: ApiSuccess<unknown>): ApiResult {
  return { __apiResult: true, status, body };
}

export function isApiResult(value: unknown): value is ApiResult {
  return typeof value === "object" && value !== null && "__apiResult" in value;
}

/** 200 with one record. `data` must be an object. */
export function okItem<T extends object>(data: T, meta: ApiMeta = {}): ApiResult {
  if (Array.isArray(data)) throw new TypeError("okItem needs an object; use okList for arrays");
  return result(200, { data, meta });
}

/** 200 with a collection. `data` is always an array, even when empty. */
export function okList<T>(items: readonly T[], meta: ApiMeta = {}): ApiResult {
  if (!Array.isArray(items)) throw new TypeError("okList needs an array; use okItem for objects");
  return result(200, { data: [...items], meta });
}

/** 201 with the created record. */
export function created<T extends object>(data: T, meta: ApiMeta = {}): ApiResult {
  if (Array.isArray(data)) throw new TypeError("created needs an object");
  return result(201, { data, meta });
}

/** 204 with no body. */
export function noContent(): ApiResult {
  return result(204);
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/** Headers every API response carries. Responses are per-user, so they are never cached. */
function baseHeaders(requestId: string, extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  headers.set("X-Request-Id", requestId);
  headers.set("Cache-Control", PRIVATE_NO_STORE);
  return headers;
}

export function successResponse(res: ApiResult, requestId: string): Response {
  const headers = baseHeaders(requestId);
  if (res.status === 204 || res.body === undefined) {
    return new Response(null, { status: 204, headers });
  }
  headers.set("Content-Type", JSON_HEADERS["Content-Type"]);
  return new Response(JSON.stringify(res.body), { status: res.status, headers });
}

/** The error envelope. Only the error's own safe message and field errors are included. */
export function errorResponse(error: ApiError, requestId: string): Response {
  const body: ApiErrorResponse = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      ...(error.meta ? { meta: error.meta } : {}),
      requestId,
    },
  };
  const headers = baseHeaders(requestId, error.headers);
  headers.set("Content-Type", JSON_HEADERS["Content-Type"]);
  return new Response(JSON.stringify(body), { status: error.status, headers });
}

/** Last-resort 500 used if even error conversion fails. */
export function internalErrorResponse(requestId: string): Response {
  return errorResponse(new InternalError(), requestId);
}

/** Adds the request ID and no-store headers to a handler's own Response (a PDF, a CSV). */
export function withBaseHeaders(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Request-Id", requestId);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", PRIVATE_NO_STORE);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
