/**
 * The one place CSV is WRITTEN (the export and the import error report both use it). Two jobs:
 *
 * 1. Spreadsheet formula injection. Excel, Google Sheets and LibreOffice treat a cell that starts with `=`, `+`, `-` or `@` as a
 *    formula, and some also act on a leading tab, carriage return or other control character. Any TEXT cell that starts with one of
 *    those gets a single quote put in front (`'=1+1`), which every spreadsheet shows as plain text. Numbers and booleans are written as
 *    they are (a real negative number must stay a number); text that merely looks like a number, such as `-5`, is text and is prefixed.
 * 2. RFC 4180 quoting: a cell with a comma, a double quote, a carriage return or a line feed is wrapped in double quotes and its quotes
 *    are doubled. Rows end with CRLF.
 *
 * The prefix changes what a spreadsheet user sees (a leading quote is not displayed, but a re-import of the file reads it). That is the
 * documented, accepted cost of the OWASP-recommended defence.
 */
export type CsvValue = string | number | boolean | null | undefined;

/** A UTF-8 byte-order mark: add it at the start of a file so Excel opens it as UTF-8 instead of the local code page. */
export const CSV_BOM = "﻿";

/** `=`, `+`, `-`, `@`, and any control character (tab, CR, LF, NUL ... US, DEL). */
// eslint-disable-next-line no-control-regex
const DANGEROUS_START = /^[=+\-@\u0000-\u001f\u007f]/;

/** Neutralizes a text cell so a spreadsheet shows it as text and never runs it. */
export function neutralizeFormula(text: string): string {
  return DANGEROUS_START.test(text) ? `'${text}` : text;
}

export function escapeCsvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = neutralizeFormula(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV record including its CRLF line ending. */
export function csvRow(cells: readonly CsvValue[]): string {
  return cells.map(escapeCsvCell).join(",") + "\r\n";
}
