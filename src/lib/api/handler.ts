import type { NextRequest } from "next/server";
import {
  errorResponse,
  internalErrorResponse,
  isApiResult,
  successResponse,
  withBaseHeaders,
  type ApiResult,
} from "./envelope";
import { assertJsonRequest } from "./json-body";
import { logUnexpectedError } from "./log";
import { resolveRequestId } from "./request-id";
import { toApiError } from "./to-api-error";

/** The second argument Next.js passes to a route handler. */
export type RouteContext<P> = { params: Promise<P> };

export type ApiHandlerArgs<P> = {
  request: NextRequest;
  /** Echoed in the `X-Request-Id` header and in every error body. */
  requestId: string;
  /** Dynamic route segments, already awaited. */
  params: P;
};

export type ApiHandler<P> = (
  args: ApiHandlerArgs<P>,
) => Promise<ApiResult | Response> | ApiResult | Response;

/**
 * Wraps a route handler so every path, success or failure, speaks the /api/v1 contract:
 *
 * - a request ID per request (accepted from a safe `X-Request-Id`, else generated), set on the
 *   response header and in error bodies;
 * - a body must be `application/json` (415 otherwise);
 * - anything thrown becomes the error envelope: `ApiError` as is, Zod as 422 with field errors,
 *   known Postgres errors as 4xx with fixed messages, everything else as a generic 500 whose
 *   details are logged server-side only;
 * - responses are `no-store`.
 *
 * ```ts
 * export const GET = withApi(async ({ requestId }) => okList(await listThings()));
 * ```
 */
export function withApi<P = Record<string, never>>(handler: ApiHandler<P>) {
  return async (request: NextRequest, context?: RouteContext<P>): Promise<Response> => {
    const requestId = resolveRequestId(request.headers);
    try {
      await assertJsonRequest(request);
      const params = (context ? await context.params : {}) as P;
      const output = await handler({ request, requestId, params });
      return isApiResult(output)
        ? successResponse(output, requestId)
        : withBaseHeaders(output, requestId);
    } catch (error) {
      try {
        const { apiError, unexpected } = toApiError(error);
        if (unexpected) logUnexpectedError(requestId, error);
        return errorResponse(apiError, requestId);
      } catch {
        // Conversion or logging itself failed: still return the envelope.
        return internalErrorResponse(requestId);
      }
    }
  };
}
