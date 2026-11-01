import type { ApiErrorCode, FieldErrors } from "./types";

/**
 * An error a route handler throws on purpose. Everything that is not an `ApiError` is mapped
 * (Zod, Postgres) or becomes a generic 500, so internals never reach the client.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode | (string & {}),
    message: string,
    public readonly fieldErrors?: FieldErrors,
    /** Extra response headers, for example `Retry-After`. */
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 400: the request itself is malformed (unparsable JSON, a bad id format). */
export class BadRequestError extends ApiError {
  constructor(message = "The request could not be understood.") {
    super(400, "BAD_REQUEST", message);
  }
}

/** 401: no valid session. */
export class UnauthorizedError extends ApiError {
  constructor(message = "Sign in to continue.") {
    super(401, "UNAUTHENTICATED", message);
  }
}

/** 403: signed in, but this role or workspace may not do that. */
export class ForbiddenError extends ApiError {
  constructor(message = "You do not have permission to do that.", code = "FORBIDDEN") {
    super(403, code, message);
  }
}

/**
 * 404: the record does not exist OR belongs to another tenant. The two must be
 * indistinguishable, so use this for both and never say which.
 */
export class NotFoundError extends ApiError {
  constructor(message = "That record was not found.", code = "NOT_FOUND") {
    super(404, code, message);
  }
}

/** 409: stale edit (the record changed since it was loaded) or a duplicate. */
export class ConflictError extends ApiError {
  constructor(
    message = "This record was changed by someone else. Reload and try again.",
    code = "CONFLICT",
  ) {
    super(409, code, message);
  }
}

/** 413: the JSON body is over the cap (enforced by the request protection issue). */
export class PayloadTooLargeError extends ApiError {
  constructor(message = "The request body is too large.") {
    super(413, "PAYLOAD_TOO_LARGE", message);
  }
}

/** 415: a request with a body that is not `application/json`. */
export class UnsupportedMediaTypeError extends ApiError {
  constructor(message = "Send the request body as application/json.") {
    super(415, "UNSUPPORTED_MEDIA_TYPE", message);
  }
}

/** 422: well-formed but invalid, or a business rule refuses it. `fieldErrors` feeds forms. */
export class ValidationError extends ApiError {
  constructor(
    message = "Please correct the highlighted fields.",
    fieldErrors?: FieldErrors,
    code = "VALIDATION_ERROR",
  ) {
    super(422, code, message, fieldErrors);
  }
}

/** 429: a quota or throttle. `retryAfterSeconds` becomes the `Retry-After` header. */
export class RateLimitError extends ApiError {
  constructor(
    message = "Too many requests. Please try again shortly.",
    public readonly retryAfterSeconds?: number,
    code = "RATE_LIMITED",
  ) {
    super(
      429,
      code,
      message,
      undefined,
      retryAfterSeconds === undefined
        ? undefined
        : { "Retry-After": String(Math.ceil(retryAfterSeconds)) },
    );
  }
}

/** 500: an unexpected failure. The message is always generic. */
export class InternalError extends ApiError {
  constructor() {
    super(500, "INTERNAL_ERROR", "Something went wrong on our side. Please try again.");
  }
}
