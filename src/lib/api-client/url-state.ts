/**
 * URL-synced list state (search, filters, sort, page), as pure functions so it is testable without React.
 * A schema names each parameter, its type and its default. Defaults are left out of the URL, so a clean list has a
 * clean URL, and the same URL always restores the same view. Unknown and invalid values fall back to the default.
 * Nothing sensitive belongs in a URL: `defineUrlState` refuses parameter names that look like secrets or contact data.
 */
export type UrlField =
  | { kind: "string"; default: string; max: number }
  | { kind: "int"; default: number; min: number; max: number }
  | { kind: "enum"; default: string; values: readonly string[] }
  | { kind: "list"; values: readonly string[] };

export type UrlSchema = Record<string, UrlField>;

type ValueOf<F extends UrlField> = F extends { kind: "string" }
  ? string
  : F extends { kind: "int" }
    ? number
    : F extends { kind: "enum" }
      ? string
      : string[];

export type UrlState<S extends UrlSchema> = { [K in keyof S]: ValueOf<S[K]> };

export const urlField = {
  /** Free text such as the search box. Trimmed and capped. */
  string: (defaultValue = "", max = 100): Extract<UrlField, { kind: "string" }> => ({
    kind: "string",
    default: defaultValue,
    max,
  }),
  int: (defaultValue: number, min = 1, max = 1_000_000): Extract<UrlField, { kind: "int" }> => ({
    kind: "int",
    default: defaultValue,
    min,
    max,
  }),
  /** One of a fixed set (a stage, a sort key). */
  enum: (values: readonly string[], defaultValue: string): Extract<UrlField, { kind: "enum" }> => ({
    kind: "enum",
    default: defaultValue,
    values,
  }),
  /** Any subset of a fixed set, in the set's order (multi-select filters). */
  list: (values: readonly string[]): Extract<UrlField, { kind: "list" }> => ({
    kind: "list",
    values,
  }),
} as const;

const FORBIDDEN_NAME =
  /token|secret|passw|apikey|api_key|authoriz|session|^key$|^e-?mail$|^phone$/i;

/** Validates the schema once (parameter names) and returns it typed. */
export function defineUrlState<const S extends UrlSchema>(schema: S): S {
  for (const name of Object.keys(schema)) {
    if (FORBIDDEN_NAME.test(name)) {
      throw new Error(`URL state "${name}": sensitive-looking names are not allowed in URLs.`);
    }
  }
  return schema;
}

type Source = { get(name: string): string | null };

export function defaultsOf<S extends UrlSchema>(schema: S): UrlState<S> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema)) {
    out[name] = field.kind === "list" ? [] : field.default;
  }
  return out as UrlState<S>;
}

function parseField(field: UrlField, raw: string | null): unknown {
  switch (field.kind) {
    case "string": {
      if (raw === null) return field.default;
      const value = raw.trim().slice(0, field.max);
      return value;
    }
    case "int": {
      if (raw === null || !/^-?\d{1,9}$/.test(raw)) return field.default;
      const n = Number(raw);
      return n < field.min || n > field.max ? field.default : n;
    }
    case "enum":
      return raw !== null && field.values.includes(raw) ? raw : field.default;
    case "list": {
      if (raw === null || raw === "") return [];
      const wanted = new Set(raw.split(","));
      return field.values.filter((v) => wanted.has(v));
    }
  }
}

export function parseUrlState<S extends UrlSchema>(schema: S, params: Source): UrlState<S> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema))
    out[name] = parseField(field, params.get(name));
  return out as UrlState<S>;
}

function isDefault(field: UrlField, value: unknown): boolean {
  if (field.kind === "list") return (value as string[]).length === 0;
  return value === field.default;
}

/** The query string (no leading `?`) for a state: schema order, defaults omitted, so equal states give equal URLs. */
export function serializeUrlState<S extends UrlSchema>(
  schema: S,
  state: Partial<UrlState<S>>,
): string {
  const params = new URLSearchParams();
  for (const [name, field] of Object.entries(schema)) {
    const value = (state as Record<string, unknown>)[name];
    if (value === undefined) continue;
    const parsed = parseField(
      field,
      field.kind === "list" ? (value as string[]).join(",") : String(value),
    );
    if (isDefault(field, parsed)) continue;
    params.set(name, field.kind === "list" ? (parsed as string[]).join(",") : String(parsed));
  }
  return params.toString();
}

/**
 * The next state after a change. A change to anything but `page` returns to page 1: a new search or filter makes
 * the old page number meaningless.
 */
export function applyUrlChange<S extends UrlSchema>(
  schema: S,
  current: UrlState<S>,
  change: Partial<UrlState<S>>,
): UrlState<S> {
  const next = { ...current, ...change } as Record<string, unknown>;
  const touchedOther = Object.keys(change).some((k) => k !== "page");
  if (touchedOther && "page" in schema && !("page" in change)) {
    next.page = (schema.page as UrlField & { kind: "int" }).default;
  }
  return next as UrlState<S>;
}
