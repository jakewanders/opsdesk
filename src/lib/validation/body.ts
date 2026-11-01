import type { z } from "zod";
import { ValidationError } from "@/lib/api/errors";
import { readJson } from "@/lib/api/json-body";
import { zodFieldErrors } from "@/lib/api/to-api-error";

/**
 * Reads the (size-capped) JSON body and validates it. Malformed JSON is a 400; a body that parses but
 * fails the schema is a 422 whose `fieldErrors` are keyed by field path (`"address.city"`, `"tags.2"`).
 * Use `z.strictObject` for write schemas so an unknown field is an error, not silently dropped.
 */
export async function parseBody<T extends z.ZodType>(
  schema: T,
  request: Request,
): Promise<z.output<T>> {
  const result = schema.safeParse(await readJson(request));
  if (!result.success) throw new ValidationError(undefined, zodFieldErrors(result.error));
  return result.data;
}
