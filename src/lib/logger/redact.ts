/**
 * Redaction for log lines (PRD 11.6). Two layers, both applied to everything a log call carries:
 *
 * 1. By key: any property whose name looks like a secret (token, password, cookie, authorization, API key,
 *    invitation, session, captcha...) or like free text a customer wrote (notes, description, body, comment...) or
 *    personal contact data (email, phone, address) is replaced, whatever its value and however deeply nested.
 * 2. By pattern: strings are scanned for JWTs, bearer tokens, provider key prefixes, long opaque tokens,
 *    `name=value` pairs with secret-looking names, connection-string passwords and e-mail addresses.
 *
 * The output is bounded (depth, array length, string length) so one log call can never be huge, and cycles are cut.
 */
export const REDACTED = "[redacted]";

const SECRET_KEY =
  /token|secret|passw(or)?d|passphrase|authorization|cookie|api[-_]?key|apikey|credential|session|jwt|bearer|invit|signature|captcha|otp|private[-_]?key|access[-_]?key|csrf|nonce/i;
const CONTENT_KEY =
  /^(notes?|description|body|content|comments?|memo|details?|text|message_body|payload|html|raw|csv|rows?|line_?items?)$/i;
const CONTACT_KEY = /^(e-?mail|phone|mobile|address|street|postcode|zip)$/i;

/** Keys that are allowed to hold identifiers even though they contain a word above (`tokenCount`, `sessionId`...). */
const SAFE_KEYS = new Set([
  "requestid",
  "orgid",
  "userid",
  "organizationid",
  "errorcode",
  "tokencount",
]);

export function isSensitiveKey(key: string): boolean {
  if (SAFE_KEYS.has(key.toLowerCase())) return false;
  return SECRET_KEY.test(key) || CONTENT_KEY.test(key) || CONTACT_KEY.test(key);
}

const PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // JWTs (Supabase access and refresh tokens, signed cookies)
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, `Basic ${REDACTED}`],
  // provider key prefixes: Supabase, Stripe, Resend, GitHub, Slack, Cloudflare
  [
    /\b(?:sb_(?:secret|publishable)_|sk_(?:live|test)_|rk_(?:live|test)_|whsec_|re_|ghp_|gho_|ghs_|github_pat_|xox[abprs]-|0x4[A-Za-z0-9_-]{20,})[A-Za-z0-9_-]{6,}/g,
    REDACTED,
  ],
  // postgres://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, (_m, prefix) => `${prefix}${REDACTED}@`],
  // name=value or name: value with a secret-looking name (cookies, query strings, headers)
  [
    /\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|apikey|api[-_]key|authorization|session|signature|captcha)[A-Za-z0-9_.-]*)\s*[=:]\s*[^\s;,&"']+/gi,
    (_m, name) => `${name}=${REDACTED}`,
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[email]"],
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Long opaque strings that mix letters and digits are almost always credentials. */
function redactOpaque(text: string): string {
  return text.replace(/[A-Za-z0-9_+/=-]{40,}/g, (run) => {
    if (UUID.test(run)) return run;
    return /[A-Za-z]/.test(run) && /\d/.test(run) ? REDACTED : run;
  });
}

export function redactString(text: string, max = 500): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement as never);
  }
  out = redactOpaque(out);
  return out.length > max ? `${out.slice(0, max)}…[truncated]` : out;
}

export type RedactOptions = { maxDepth?: number; maxArray?: number; maxString?: number };

function redactError(error: Error, max: number): Record<string, unknown> {
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    message: redactString(error.message, Math.min(max, 300)),
  };
}

export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const { maxDepth = 6, maxArray = 20, maxString = 500 } = options;
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v;
    switch (typeof v) {
      case "string":
        return redactString(v, maxString);
      case "number":
      case "boolean":
        return v;
      case "bigint":
        return v.toString();
      case "function":
      case "symbol":
        return undefined;
    }
    const obj = v as object;
    if (obj instanceof Error) return redactError(obj, maxString);
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
    if (seen.has(obj)) return "[circular]";
    if (depth >= maxDepth) return "[depth limit]";
    seen.add(obj);
    if (Array.isArray(obj)) {
      const items = obj.slice(0, maxArray).map((item) => walk(item, depth + 1));
      if (obj.length > maxArray) items.push(`[${obj.length - maxArray} more]`);
      return items;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : walk(item, depth + 1);
    }
    return out;
  };

  return walk(value, 0);
}
