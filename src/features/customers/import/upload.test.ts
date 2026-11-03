import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PayloadTooLargeError, ValidationError } from "@/lib/api/errors";
import { IMPORT_MAX_BYTES } from "./analyze";
import { decodeUpload } from "./upload";

/** [SIT-266] The first thing an import does with a file: bytes to text. Strict UTF-8, a byte-order mark dropped, 2 MB at most. */
const b64 = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64");
const sha = (bytes: Uint8Array | Buffer) => createHash("sha256").update(bytes).digest("hex");
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ValidationError ? (e as ValidationError).code : (e as Error).name;
  }
  return "no error";
};

describe("decodeUpload", () => {
  it("decodes UTF-8 text with accents, CJK and emoji exactly", () => {
    const text = "display_name\nÜnïcode Ltd\n山田太郎\n🙂 Smile\n";
    expect(decodeUpload(b64(Buffer.from(text, "utf8"))).text).toBe(text);
  });

  it("drops a leading byte-order mark from the text but hashes the exact bytes uploaded", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("display_name\nAda\n"),
    ]);
    const { text, fileSha256 } = decodeUpload(b64(bytes));
    expect(text).toBe("display_name\nAda\n");
    expect(fileSha256).toBe(sha(bytes));
    // the same rows without the mark are a different file
    expect(decodeUpload(b64(Buffer.from("display_name\nAda\n"))).fileSha256).not.toBe(fileSha256);
  });

  it("keeps CRLF, lone CR and quoted line breaks as they were typed", () => {
    const text = 'display_name,notes\r\nAda,"a\r\nb"\rBo,x\n';
    expect(decodeUpload(b64(Buffer.from(text))).text).toBe(text);
  });

  it.each([
    [
      "Latin-1 (windows) é",
      Buffer.from([0x64, 0x69, 0x73, 0x70, 0x6c, 0x61, 0x79, 0x0a, 0x4a, 0x6f, 0x73, 0xe9]),
    ],
    ["a lone 0xFF byte", Buffer.from([0x41, 0xff, 0x42])],
    ["a truncated multi-byte sequence", Buffer.from([0x41, 0xe2, 0x82])],
    ["an overlong encoding", Buffer.from([0xc0, 0xaf])],
    ["a UTF-16 file", Buffer.from("﻿display_name\nAda\n", "utf16le")],
  ])("refuses %s as not UTF-8, never replacing characters", (_label, bytes) => {
    expect(code(() => decodeUpload(b64(bytes)))).toBe("IMPORT_NOT_UTF8");
  });

  it("refuses an empty file", () => {
    expect(code(() => decodeUpload(""))).toBe("IMPORT_EMPTY_FILE");
  });

  it("accepts exactly 2 MB and refuses one byte more (413)", () => {
    const line = "display_name\n";
    const exact = Buffer.alloc(IMPORT_MAX_BYTES, 0x61);
    exact.write(line, 0);
    expect(decodeUpload(b64(exact)).text.length).toBe(IMPORT_MAX_BYTES);
    expect(() => decodeUpload(b64(Buffer.alloc(IMPORT_MAX_BYTES + 1, 0x61)))).toThrow(
      PayloadTooLargeError,
    );
  });

  it("gives the same hash for the same bytes however they are chunked in base64", () => {
    const bytes = Buffer.from("display_name\nAda\nBo\n");
    expect(decodeUpload(b64(bytes)).fileSha256).toBe(decodeUpload(b64(bytes)).fileSha256);
  });
});
