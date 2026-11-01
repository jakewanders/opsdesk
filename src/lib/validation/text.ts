import { z } from "zod";

/**
 * Free text is plain text, everywhere (PRD 7.5). It is stored and returned exactly as typed (after
 * trimming and Unicode normalization) and is only ever rendered through React's escaping; there is no
 * HTML sanitizer because there is no HTML. As defence in depth these schemas also refuse anything that
 * looks like a tag, so a script or markup injection attempt is a 422 instead of stored data.
 *
 * Lengths are counted in Unicode code points, the same unit as Postgres `varchar(n)`/`char_length`,
 * so a value that passes here never fails a database length constraint (an emoji is 1, not 2).
 */

/** Builds a character class from code point ranges, so no invisible character is ever typed into source. */
const charClass = (ranges: ReadonlyArray<readonly [number, number?]>) =>
  new RegExp(
    `[${ranges
      .map(([from, to]) => {
        const hex = (n: number) => `\\u{${n.toString(16)}}`;
        return to === undefined ? hex(from) : `${hex(from)}-${hex(to)}`;
      })
      .join("")}]`,
    "u",
  );

/**
 * C0/C1 controls except tab/newline/CR (line breaks are checked per field type), DEL, zero-width and
 * bidirectional override characters (used for "Trojan source" style spoofing). ZWJ (U+200D) and variation
 * selectors are allowed because emoji sequences need them.
 */
const FORBIDDEN_INVISIBLE = charClass([
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x200b],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2060],
  [0x2066, 0x2069],
  [0xfeff],
]);
/** LF, CR, NEL, line separator, paragraph separator. */
const LINE_BREAKS = charClass([[0x0a], [0x0d], [0x85], [0x2028, 0x2029]]);
/** `<` followed by a letter, `/`, `!` or `?` starts a tag, comment, doctype or processing instruction (browsers ignore `< x`, so plain "a < b" is fine). */
const TAG_LIKE = /<[a-zA-Z/!?]/u;

export const codePointLength = (value: string): number => [...value].length;

const MESSAGES = {
  required: "Enter a value.",
  control: "Remove unsupported characters.",
  lineBreak: "Use a single line.",
  html: "Remove HTML tags; only plain text is allowed.",
};

function checkText(value: string, ctx: z.RefinementCtx, opts: { multiline: boolean }): void {
  const invisible = FORBIDDEN_INVISIBLE.test(value);
  if (invisible) ctx.addIssue({ code: "custom", message: MESSAGES.control });
  if (!opts.multiline && LINE_BREAKS.test(value)) {
    ctx.addIssue({ code: "custom", message: MESSAGES.lineBreak });
  }
  if (TAG_LIKE.test(value)) ctx.addIssue({ code: "custom", message: MESSAGES.html });
}

function lengthMessage(min: number, max: number): string {
  if (min <= 1) return `Use ${max} characters or fewer.`;
  return `Use between ${min} and ${max} characters.`;
}

function build(min: number, max: number, multiline: boolean) {
  return z
    .string({ error: MESSAGES.required })
    .transform((v) => {
      const normalized = v.normalize("NFC").trim();
      return multiline ? normalized.replace(/\r\n?/g, "\n") : normalized;
    })
    .superRefine((value, ctx) => {
      const length = codePointLength(value);
      if (length < min) {
        ctx.addIssue({
          code: "custom",
          message: min <= 1 ? MESSAGES.required : lengthMessage(min, max),
        });
      } else if (length > max) {
        ctx.addIssue({ code: "custom", message: lengthMessage(min, max) });
      }
      checkText(value, ctx, { multiline });
    });
}

/** Trimmed, NFC-normalized single-line text of `min..max` code points. No control characters, no tags. */
export const singleLine = (max: number, min = 1) => build(min, max, false);

/** As `singleLine`, but newlines are allowed (notes, descriptions). `\r\n` becomes `\n`. */
export const multiLine = (max: number, min = 1) => build(min, max, true);

/** Optional single-line field: blank or missing becomes `null`. */
export const optionalSingleLine = (max: number) =>
  z
    .union([z.null(), z.undefined(), z.string()])
    .transform((v) => (v == null || v.trim() === "" ? null : v))
    .pipe(z.union([z.null(), singleLine(max)]));

/** Optional multi-line field: blank or missing becomes `null`. */
export const optionalMultiLine = (max: number) =>
  z
    .union([z.null(), z.undefined(), z.string()])
    .transform((v) => (v == null || v.trim() === "" ? null : v))
    .pipe(z.union([z.null(), multiLine(max)]));
