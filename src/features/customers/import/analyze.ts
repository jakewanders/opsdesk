import { CsvError, DEFAULT_CSV_LIMITS, parseCsv } from "@/lib/csv/parse";
import { createCustomerSchema, type CreateCustomerInput } from "../schema";

/**
 * Turns the text of an uploaded customers CSV into a preview: which columns were understood, which rows are valid, and exactly
 * what is wrong with the others. Pure: no database, no network. Every row is validated with the same schema as `POST /customers`,
 * so an imported customer follows exactly the rules of a typed one.
 *
 * Row numbers are spreadsheet row numbers: the header is row 1, the first customer is row 2.
 */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 1000;
/** The preview shows this many rows; the rest are counted and validated but not echoed. */
export const PREVIEW_ROWS = 20;
/** The response lists at most this many errors (and warnings); the counts are always complete. */
export const MAX_LISTED_ISSUES = 500;
/** The stored job summary keeps at most this many errors (row, field and code only). */
export const MAX_STORED_ERRORS = 200;

type CustomerField = keyof Pick<
  CreateCustomerInput,
  | "type"
  | "displayName"
  | "companyName"
  | "email"
  | "phone"
  | "website"
  | "status"
  | "source"
  | "tags"
  | "notes"
>;

/** Header names that are understood, compared after lower-casing and removing everything but letters and digits. */
const HEADERS: Record<string, CustomerField> = {
  displayname: "displayName",
  name: "displayName",
  type: "type",
  companyname: "companyName",
  company: "companyName",
  email: "email",
  emailaddress: "email",
  phone: "phone",
  phonenumber: "phone",
  website: "website",
  url: "website",
  status: "status",
  source: "source",
  tags: "tags",
  notes: "notes",
};
const ENUM_FIELDS: ReadonlySet<CustomerField> = new Set(["type", "status", "source"]);

export type ColumnMapping = { header: string; field: CustomerField };

export type RowIssue = {
  /** Spreadsheet row number (header = 1). */
  row: number;
  field: string | null;
  code: string;
  message: string;
  /** For DUPLICATE_IN_FILE: the earlier row that has the same e-mail. */
  firstRow?: number;
};

export type PreviewRow = {
  row: number;
  valid: boolean;
  /** The cells as typed, keyed by customer field. */
  values: Partial<Record<CustomerField, string>>;
  errors: RowIssue[];
  warnings: RowIssue[];
};

export type ImportAnalysis = {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  columns: { mapped: ColumnMapping[]; unknown: string[] };
  rows: PreviewRow[];
  errors: RowIssue[];
  warnings: RowIssue[];
  /** The valid rows as customer input, in file order. The commit step re-derives these from the same file. */
  valid: Array<{ row: number; input: CreateCustomerInput }>;
};

/** A problem with the file as a whole (not one row): the request is refused with this code and message. */
export class ImportFileError extends Error {
  constructor(
    public readonly code:
      | "EMPTY_FILE"
      | "NOT_CSV"
      | "MISSING_COLUMN"
      | "DUPLICATE_COLUMN"
      | "TOO_MANY_ROWS"
      | "TOO_MANY_COLUMNS"
      | "CELL_TOO_LONG"
      | "NO_DATA_ROWS",
    message: string,
  ) {
    super(message);
    this.name = "ImportFileError";
  }
}

/**
 * A stable machine code for a Zod issue (the message stays the human text). The shared text schemas report their rules as custom
 * issues with fixed messages, so those are recognised by message.
 */
function issueCode(code: string, message: string, blank: boolean): string {
  if (blank || message === "Enter a value.") return "REQUIRED";
  if (message === "Enter a valid email address.") return "INVALID_EMAIL";
  if (code === "custom") {
    if (message.startsWith("Use ")) return "WRONG_LENGTH";
    if (message === "Remove unsupported characters.") return "INVALID_CHARACTERS";
    if (message === "Use a single line.") return "SINGLE_LINE_ONLY";
    if (message.startsWith("Remove HTML")) return "NO_HTML";
    return "INVALID_VALUE";
  }
  switch (code) {
    case "too_small":
      return "TOO_SHORT";
    case "too_big":
      return "TOO_LONG";
    case "invalid_value":
      return "INVALID_CHOICE";
    case "invalid_format":
      return "INVALID_FORMAT";
    default:
      return "INVALID";
  }
}

type Issue = {
  code: string;
  message: string;
  path: PropertyKey[];
  errors?: Issue[][];
  expected?: string;
};

/** Optional fields are `null | schema` unions; report the schema's complaint, not "Invalid input". */
function innermost(issue: Issue): Issue {
  if (issue.code !== "invalid_union" || !issue.errors) return issue;
  const candidates = issue.errors
    .flat()
    .filter((i) => !(i.code === "invalid_type" && i.expected === "null"));
  return candidates.length > 0 ? { ...innermost(candidates[0]), path: issue.path } : issue;
}

const compact = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");

function mapHeader(headerRow: string[]): {
  mapped: Array<ColumnMapping | null>;
  unknown: string[];
} {
  const seen = new Map<CustomerField, string>();
  const mapped: Array<ColumnMapping | null> = [];
  const unknown: string[] = [];
  for (const raw of headerRow) {
    const header = raw.trim();
    const field = HEADERS[compact(header)];
    if (!field) {
      mapped.push(null);
      if (header !== "") unknown.push(header);
      continue;
    }
    const earlier = seen.get(field);
    if (earlier !== undefined)
      throw new ImportFileError(
        "DUPLICATE_COLUMN",
        `The columns "${earlier}" and "${header}" both fill ${field}. Keep only one of them.`,
      );
    seen.set(field, header);
    mapped.push({ header, field });
  }
  if (!seen.has("displayName"))
    throw new ImportFileError(
      "MISSING_COLUMN",
      'The file needs a "display_name" column (or "name"). Add it to the first row.',
    );
  return { mapped, unknown };
}

const splitTags = (cell: string) =>
  cell
    .split(/[;,|]/)
    .map((t) => t.trim())
    .filter((t) => t !== "");

/**
 * Analyses CSV text. `existingEmails` are the workspace's customer e-mails (lower-case) for the duplicate warning.
 * Throws {@link ImportFileError} for a file that cannot be previewed at all.
 */
export function analyzeCustomerCsv(
  text: string,
  existingEmails: ReadonlySet<string>,
): ImportAnalysis {
  let table: string[][];
  try {
    table = parseCsv(text, { ...DEFAULT_CSV_LIMITS, maxDataRows: IMPORT_MAX_ROWS });
  } catch (e) {
    if (e instanceof CsvError) {
      const code =
        e.code === "EMPTY"
          ? "EMPTY_FILE"
          : e.code === "UNTERMINATED_QUOTE"
            ? "NOT_CSV"
            : e.code === "TOO_MANY_ROWS"
              ? "TOO_MANY_ROWS"
              : e.code === "TOO_MANY_COLUMNS"
                ? "TOO_MANY_COLUMNS"
                : "CELL_TOO_LONG";
      throw new ImportFileError(code, e.message);
    }
    throw e;
  }

  const { mapped, unknown } = mapHeader(table[0]);
  const dataRows = table.slice(1);
  if (dataRows.length === 0)
    throw new ImportFileError(
      "NO_DATA_ROWS",
      "The file has a header row but no customers under it.",
    );

  const analysis: ImportAnalysis = {
    totalRows: dataRows.length,
    validRows: 0,
    invalidRows: 0,
    columns: { mapped: mapped.filter((m): m is ColumnMapping => m !== null), unknown },
    rows: [],
    errors: [],
    warnings: [],
    valid: [],
  };
  const firstRowWithEmail = new Map<string, number>();

  dataRows.forEach((cells, index) => {
    const row = index + 2;
    const values: Partial<Record<CustomerField, string>> = {};
    const errors: RowIssue[] = [];
    const warnings: RowIssue[] = [];

    if (cells.length > mapped.length && cells.slice(mapped.length).some((c) => c.trim() !== "")) {
      errors.push({
        row,
        field: null,
        code: "TOO_MANY_CELLS",
        message: `This row has ${cells.length} cells but the header has ${mapped.length}.`,
      });
    }
    const candidate: Record<string, unknown> = {};
    mapped.forEach((column, i) => {
      if (!column) return;
      const raw = cells[i] ?? "";
      if (raw.trim() !== "") values[column.field] = raw;
      if (raw.trim() === "") return; // blank: the field's own default applies (required fields fail below)
      if (column.field === "tags") candidate.tags = splitTags(raw);
      else if (ENUM_FIELDS.has(column.field)) candidate[column.field] = raw.trim().toLowerCase();
      else candidate[column.field] = raw;
    });

    const parsed = createCustomerSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const raw of parsed.error.issues as Issue[]) {
        const issue = innermost(raw);
        const field = typeof issue.path[0] === "string" ? issue.path[0] : null;
        const blank = field === "displayName" && candidate.displayName === undefined;
        errors.push({
          row,
          field,
          code: issueCode(issue.code, issue.message, blank),
          message: blank ? "Enter a name." : issue.message,
        });
      }
    } else if (errors.length === 0) {
      const input = parsed.data;
      if (input.email) {
        const earlier = firstRowWithEmail.get(input.email);
        if (earlier !== undefined) {
          warnings.push({
            row,
            field: "email",
            code: "DUPLICATE_IN_FILE",
            message: `This email address is also on row ${earlier}.`,
            firstRow: earlier,
          });
        } else {
          firstRowWithEmail.set(input.email, row);
        }
        if (existingEmails.has(input.email)) {
          warnings.push({
            row,
            field: "email",
            code: "DUPLICATE_EXISTING",
            message: "A customer in this workspace already uses this email address.",
          });
        }
      }
      analysis.valid.push({ row, input });
    }

    const valid = errors.length === 0;
    if (valid) analysis.validRows++;
    else analysis.invalidRows++;
    analysis.errors.push(...errors);
    analysis.warnings.push(...warnings);
    if (analysis.rows.length < PREVIEW_ROWS)
      analysis.rows.push({ row, valid, values, errors, warnings });
  });

  return analysis;
}

/** The summary stored on the job: row numbers, fields and codes only, never a cell's content or a message. */
export function storedErrorSummary(analysis: ImportAnalysis) {
  const byCode: Record<string, number> = {};
  for (const e of analysis.errors) byCode[e.code] = (byCode[e.code] ?? 0) + 1;
  return {
    errors: analysis.errors
      .slice(0, MAX_STORED_ERRORS)
      .map((e) => ({ row: e.row, field: e.field, code: e.code })),
    truncated: analysis.errors.length > MAX_STORED_ERRORS,
    byCode,
  };
}
