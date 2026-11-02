import type { NextRequest } from "next/server";
import {
  errorResponse,
  internalErrorResponse,
  isApiResult,
  successResponse,
  withBaseHeaders,
  type ApiResult,
} from "./envelope";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { CurrentUser } from "@/lib/supabase/resolve-user";
import { resolveOrg, type OrgContext, type SelectOptions } from "./org-context";
import { UnauthorizedError } from "./errors";
import { assertJsonRequest } from "./json-body";
import { logUnexpectedError } from "./log";
import { resolveRequestId } from "./request-id";
import {
  assertContentLengthWithin,
  assertTrustedOrigin,
  DEFAULT_MAX_BODY_BYTES,
  isMutation,
  setBodyLimit,
} from "./request-guard";
import { toApiError } from "./to-api-error";

/** The second argument Next.js passes to a route handler. */
export type RouteContext<P> = { params: Promise<P> };

export type ApiHandlerArgs<P> = {
  request: NextRequest;
  /** Echoed in the `X-Request-Id` header and in every error body. */
  requestId: string;
  /** Dynamic route segments, already awaited. */
  params: P;
  /** The verified user. Always set when `auth` is `"required"` (the default); null when signed out under `"optional"`. */
  user: CurrentUser | null;
};

export type ApiOptions = {
  /**
   * `"required"` (default): the user is verified with Supabase Auth on every request and a signed-out
   * caller gets 401. `"optional"`: resolved but may be null (for example demo bootstrap).
   * `"none"`: not resolved (public endpoints such as health).
   */
  auth?: "required" | "optional" | "none";
  /** JSON body cap in bytes. Default 100 KB; raise per route (CSV import: 2 MB). */
  maxBodyBytes?: number;
  /** Trusted origins for mutations. Default: validated env. Injectable for tests. */
  trustedOrigins?: () => readonly string[];
  /** Verifies the caller with Supabase Auth. Default: the cookie session. Injectable for tests. */
  resolveUser?: () => Promise<CurrentUser | null>;
  /** Opt out of the Origin check. Only for signature-verified webhooks (Stripe, if P2 is built). */
  skipOriginCheck?: boolean;
};

async function defaultResolveUser(): Promise<CurrentUser | null> {
  const { getCurrentUser } = await import("@/lib/supabase/current-user");
  return getCurrentUser();
}

async function defaultTrustedOrigins(): Promise<readonly string[]> {
  const { getTrustedOrigins } = await import("./trusted-origins");
  return getTrustedOrigins();
}

export type ApiHandler<P> = (
  args: ApiHandlerArgs<P>,
) => Promise<ApiResult | Response> | ApiResult | Response;

/**
 * Wraps a route handler so every path, success or failure, speaks the /api/v1 contract:
 *
 * - a request ID per request (accepted from a safe `X-Request-Id`, else generated), set on the
 *   response header and in error bodies;
 * - a mutation must come from a trusted `Origin` (403 otherwise; see `assertTrustedOrigin`);
 * - a declared body over the cap is 413 before it is read; a body must be `application/json` (415);
 * - the caller is verified with Supabase Auth on every request (401 when signed out) unless
 *   the route sets `auth: "optional"` or `"none"`;
 * - anything thrown becomes the error envelope: `ApiError` as is, Zod as 422 with field errors,
 *   known Postgres errors as 4xx with fixed messages, everything else as a generic 500 whose
 *   details are logged server-side only;
 * - responses are `no-store`.
 *
 * ```ts
 * export const GET = withApi(async ({ requestId }) => okList(await listThings()));
 * ```
 */
export function withApi<P = Record<string, never>>(
  handler: ApiHandler<P>,
  options: ApiOptions = {},
) {
  const { auth = "required", maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = options;
  return async (request: NextRequest, context?: RouteContext<P>): Promise<Response> => {
    const requestId = resolveRequestId(request.headers);
    try {
      if (isMutation(request.method) && !options.skipOriginCheck) {
        assertTrustedOrigin(request, options.trustedOrigins?.() ?? (await defaultTrustedOrigins()));
      }
      setBodyLimit(request, maxBodyBytes);
      assertContentLengthWithin(request, maxBodyBytes);
      await assertJsonRequest(request);
      let user: CurrentUser | null = null;
      if (auth !== "none") {
        user = await (options.resolveUser ?? defaultResolveUser)();
        if (auth === "required" && user === null) throw new UnauthorizedError();
      }
      const params = (context ? await context.params : {}) as P;
      const output = await handler({ request, requestId, params, user });
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

export type OrgApiHandlerArgs<P> = Omit<ApiHandlerArgs<P>, "user"> & {
  user: CurrentUser;
  /** The verified organization, role and kind for this request. */
  org: OrgContext;
  /** Supabase client acting as the caller (RLS applies). Never the admin client. */
  supabase: SupabaseClient<Database>;
};

export type OrgApiOptions = Omit<ApiOptions, "auth"> &
  SelectOptions & {
    /** Test seam: replaces the cookie-session client. */
    createSupabase?: () => Promise<SupabaseClient<Database>>;
  };

/**
 * `withApi` for tenant routes: the caller is verified (401), the organization is resolved from the
 * `X-Organization-Id` header and proven against the caller's memberships (404 / 422 / 403 `DEMO_EXPIRED`),
 * and the handler receives a typed `org`, the verified `user` and a session-scoped Supabase client.
 *
 * ```ts
 * export const GET = withOrgApi(async ({ org, supabase }) => okList(await listThings(supabase, org.org.id)));
 * ```
 */
export function withOrgApi<P = Record<string, never>>(
  handler: (args: OrgApiHandlerArgs<P>) => Promise<ApiResult | Response> | ApiResult | Response,
  options: OrgApiOptions = {},
) {
  const { allowExpired, now, createSupabase, ...apiOptions } = options;
  return withApi<P>(
    async (args) => {
      const user = args.user;
      if (!user) throw new UnauthorizedError();
      const supabase = await (createSupabase ?? defaultCreateSupabase)();
      const org = await resolveOrg(args.request, user, supabase, { allowExpired, now });
      return handler({ ...args, user, org, supabase });
    },
    { ...apiOptions, auth: "required" },
  );
}

async function defaultCreateSupabase(): Promise<SupabaseClient<Database>> {
  const { createClient } = await import("@/lib/supabase/server");
  return createClient();
}
