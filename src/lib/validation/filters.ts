import { z } from "zod";
import { singleLine } from "./text";

/**
 * Filter values that arrive in a query string. Every one is validated to a narrow shape before it is used, and the repositories pass
 * them to the database as parameters, never as SQL text.
 */

/** A whole number of cents, written as digits (`amountMin=150000`). Up to 11 digits, so the largest value is far inside a safe integer. */
export const centsParam = (name: string) =>
  z
    .string()
    .regex(/^\d{1,11}$/, `${name} must be a whole number of cents.`)
    .transform(Number);

/**
 * A list of tags written `a,b,c`: one to five tags of 1 to 30 characters, plain single-line text (the same rules as a customer's own
 * tags), repeats removed. A record matches when it has ALL of them.
 */
export const tagFilter = () =>
  z
    .string()
    .transform((text) => [...new Set(text.split(",").map((t) => t.trim()))])
    .pipe(
      z
        .array(singleLine(30), { error: "Use tags separated by commas." })
        .min(1, "Name at least one tag.")
        .max(5, "Filter by at most 5 tags."),
    );
