import { z } from "zod";
import { uuid } from "@/lib/validation";
import { IMPORT_MAX_BYTES } from "./analyze";

/** Base64 of the largest accepted file, plus a little room: a file one byte over the cap must reach the size check and get its message. */
export const MAX_BASE64_LENGTH = Math.ceil((IMPORT_MAX_BYTES + 3) / 3) * 4;
/** The JSON body cap for the preview route: the base64 text plus the envelope. */
export const PREVIEW_BODY_LIMIT = MAX_BASE64_LENGTH + 1024;

/**
 * Body of POST /api/v1/imports/customers/preview. Mutations must be JSON (SIT-181), so the file travels as base64 text: the server
 * decodes the bytes itself, which is what lets it check the encoding, count the real size and hash exactly what was uploaded.
 */
export const previewImportSchema = z.strictObject({
  content: z
    .string({ error: "Attach a CSV file." })
    .min(1, "Attach a CSV file.")
    .max(MAX_BASE64_LENGTH, "The file is larger than 2 MB.")
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, "The file must be base64 text."),
});
export type PreviewImportInput = z.output<typeof previewImportSchema>;

/**
 * Body of POST /api/v1/imports/customers/commit: the job the preview made and the SAME file again. The server re-reads and re-validates
 * every row (the preview's rows are never trusted) and refuses a file whose SHA-256 is not the job's.
 */
export const commitImportSchema = z.strictObject({
  importJobId: uuid(),
  content: previewImportSchema.shape.content,
});
export type CommitImportInput = z.output<typeof commitImportSchema>;
