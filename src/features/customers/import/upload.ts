import { createHash } from "node:crypto";
import { PayloadTooLargeError, ValidationError } from "@/lib/api/errors";
import { IMPORT_MAX_BYTES } from "./analyze";

/**
 * Turns the base64 `content` of an import request into text and the SHA-256 of the exact bytes uploaded. Used by the preview and the
 * commit, so both see the same file the same way: at most 2 MB, strict UTF-8 (a byte-order mark is dropped; invalid sequences are refused,
 * never replaced), not empty.
 */
export function decodeUpload(contentBase64: string): { text: string; fileSha256: string } {
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.length > IMPORT_MAX_BYTES)
    throw new PayloadTooLargeError("The file is larger than 2 MB. Split it into smaller files.");
  if (bytes.length === 0)
    throw new ValidationError("The file is empty.", undefined, "IMPORT_EMPTY_FILE");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationError(
      "The file is not UTF-8 text. In your spreadsheet, export or save it as CSV (UTF-8).",
      undefined,
      "IMPORT_NOT_UTF8",
    );
  }
  return { text, fileSha256: createHash("sha256").update(bytes).digest("hex") };
}
