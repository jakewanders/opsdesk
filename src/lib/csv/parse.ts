/**
 * A small, bounded CSV reader (RFC 4180 plus the usual leniencies). It only ever turns text into rows of strings: nothing in a cell is
 * evaluated, interpreted or fetched, so a cell that starts with `=`, `+`, `-` or `@` is just text here (the export neutralizes those).
 *
 * Handles: a leading byte-order mark, quoted fields with embedded commas, doubled quotes (`""`) and embedded line breaks, and CRLF, LF
 * or lone CR line endings. Completely blank lines are skipped. A quote that never closes is an error, as is going past a limit; the
 * limits are checked while reading, so an oversized file stops early instead of being held in memory.
 */
export type CsvLimits = {
  /** Most records after the header row. */
  maxDataRows: number;
  /** Most columns in any record. */
  maxColumns: number;
  /** Most characters in one cell. */
  maxCellLength: number;
};

export const DEFAULT_CSV_LIMITS: CsvLimits = {
  maxDataRows: 1000,
  maxColumns: 50,
  maxCellLength: 10000,
};

export type CsvErrorCode =
  "EMPTY" | "UNTERMINATED_QUOTE" | "TOO_MANY_ROWS" | "TOO_MANY_COLUMNS" | "CELL_TOO_LONG";

export class CsvError extends Error {
  constructor(
    public readonly code: CsvErrorCode,
    message: string,
    /** The 1-based row the problem was found on, when it has one. */
    public readonly row?: number,
  ) {
    super(message);
    this.name = "CsvError";
  }
}

/** Parses `text` into records (the first is the header). Throws {@link CsvError}. */
export function parseCsv(text: string, limits: CsvLimits = DEFAULT_CSV_LIMITS): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let cellStarted = false; // true once the current cell has any content or a quote, so `""` differs from nothing

  const endCell = () => {
    if (cell.length > limits.maxCellLength)
      throw new CsvError(
        "CELL_TOO_LONG",
        `A cell on row ${rows.length + 1} is longer than ${limits.maxCellLength} characters.`,
        rows.length + 1,
      );
    row.push(cell);
    if (row.length > limits.maxColumns)
      throw new CsvError(
        "TOO_MANY_COLUMNS",
        `Row ${rows.length + 1} has more than ${limits.maxColumns} columns.`,
        rows.length + 1,
      );
    cell = "";
    cellStarted = false;
  };
  const endRow = () => {
    endCell();
    const blank = row.length === 1 && row[0] === "" && !rowHadQuote;
    if (!blank) {
      rows.push(row);
      if (rows.length > limits.maxDataRows + 1)
        throw new CsvError(
          "TOO_MANY_ROWS",
          `The file has more than ${limits.maxDataRows} rows of data.`,
          rows.length,
        );
    }
    row = [];
    rowHadQuote = false;
  };
  let rowHadQuote = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
        if (cell.length > limits.maxCellLength + 1)
          throw new CsvError(
            "CELL_TOO_LONG",
            `A cell on row ${rows.length + 1} is longer than ${limits.maxCellLength} characters.`,
            rows.length + 1,
          );
      }
      continue;
    }
    if (c === '"' && !cellStarted) {
      inQuotes = true;
      cellStarted = true;
      rowHadQuote = true;
    } else if (c === ",") {
      endCell();
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      endRow();
    } else {
      cell += c;
      cellStarted = true;
    }
  }
  if (inQuotes)
    throw new CsvError(
      "UNTERMINATED_QUOTE",
      `A quoted cell that starts on row ${rows.length + 1} never ends.`,
      rows.length + 1,
    );
  if (cell !== "" || row.length > 0 || cellStarted) endRow();
  if (rows.length === 0) throw new CsvError("EMPTY", "The file has no rows.");
  return rows;
}
