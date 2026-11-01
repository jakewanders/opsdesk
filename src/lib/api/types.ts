/**
 * The /api/v1 contract (PRD 7.3). These types are shared by route handlers (`withApi`) and by
 * the typed client (SIT-184), so both sides agree on one shape.
 */

/** Machine-readable error codes. A client may branch on `code`; the message is for people. */
export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

/** Field name to the messages for that field, for forms. */
export type FieldErrors = Record<string, string[]>;

/** The `error` object inside an error response. */
export type ApiErrorBody = {
  code: ApiErrorCode | (string & {});
  message: string;
  fieldErrors?: FieldErrors;
  requestId: string;
};

export type ApiErrorResponse = { error: ApiErrorBody };

/** Collection metadata (pagination is filled in by the list endpoints, SIT-182). */
export type ApiMeta = {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  [key: string]: unknown;
};

/** A success response. `data` is an object for item endpoints and an array for list endpoints, always. */
export type ApiSuccess<T> = { data: T; meta: ApiMeta };

export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const error = (value as { error: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as ApiErrorBody).code === "string" &&
    typeof (error as ApiErrorBody).message === "string" &&
    typeof (error as ApiErrorBody).requestId === "string"
  );
}
