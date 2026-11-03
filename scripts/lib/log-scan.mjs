// A second, independent check on what the server writes to its logs (PRD 11.6, SIT-275). The logger redacts by key and by
// pattern; this scan looks at the finished output with its own rules, so a hole in the redactor shows up here.
// It reads JSON log lines only (an optional "[WebServer] " prefix is allowed) and returns what it found, never the value in full.

const PREFIX = /^\[WebServer\]\s*/;
const SECRET_KEY =
  /token|secret|passw(or)?d|passphrase|authorization|cookie|api[-_]?key|apikey|credential|session|jwt|bearer|invit|signature|captcha|otp|private[-_]?key|access[-_]?key|csrf|nonce/i;
const CONTENT_KEY =
  /^(notes?|description|body|content|comments?|memo|details?|text|message_body|payload|html|raw|csv|rows?|line_?items?)$/i;
const CONTACT_KEY = /^(e-?mail|phone|mobile|address|street|postcode|zip)$/i;
const SAFE_KEYS = new Set([
  "requestid",
  "orgid",
  "userid",
  "organizationid",
  "errorcode",
  "tokencount",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @type {Array<[string, RegExp]>} */
const TEXT_RULES = [
  ["jwt", /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/],
  ["bearer token", /\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/i],
  [
    "provider key",
    /\b(?:sb_(?:secret|publishable)_|sk_(?:live|test)_|whsec_|ghp_|github_pat_|xox[abprs]-)[A-Za-z0-9_-]{6,}/,
  ],
  ["auth cookie name", /\bsb-[a-z0-9-]+-auth-token/i],
  ["set-cookie / cookie header", /\b(?:set-cookie|cookie)\s*[:=]\s*(?!\[redacted\])[^\s]/i],
  ["e-mail address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/],
  ["password in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?!\[redacted\])[^\s@/]+@/i],
  ["stack frame", /\n?\s+at\s+[\w.<>$ ]+\s\(?(?:\/|file:|node:)[^\s)]+:\d+/],
  [
    "SQL text",
    /\b(?:select\s+[\w*,\s."]+\s+from|insert\s+into|update\s+\w+\s+set|delete\s+from)\s/i,
  ],
  [
    "database internals",
    /\b(?:violates (?:foreign key|unique|check) constraint|duplicate key value|relation "[\w.]+" does not exist|SQLSTATE)/i,
  ],
  ["connection refusal detail", /\b(?:ECONNREFUSED|fetch failed)\b/],
];

function longOpaque(text) {
  for (const run of text.match(/[A-Za-z0-9_+/=-]{40,}/g) ?? []) {
    if (UUID.test(run)) continue;
    if (/[A-Za-z]/.test(run) && /\d/.test(run)) return run;
  }
  return null;
}

function walk(value, path, found, depth = 0) {
  if (depth > 12 || value === null || typeof value !== "object") return;
  for (const [key, v] of Object.entries(value)) {
    const sensitive =
      !SAFE_KEYS.has(key.toLowerCase()) &&
      (SECRET_KEY.test(key) || CONTENT_KEY.test(key) || CONTACT_KEY.test(key));
    if (sensitive && v !== "[redacted]" && v !== "[email]" && v !== null && v !== "") {
      found.push(["unredacted sensitive key", `${[...path, key].join(".")}`]);
    }
    walk(v, [...path, key], found, depth + 1);
  }
}

/**
 * @param {string[]} lines raw output lines
 * @returns {{ jsonLines: number, findings: Array<{ line: number, rule: string, where: string }> }}
 */
export function scanLogLines(lines) {
  const findings = [];
  let jsonLines = 0;
  lines.forEach((raw, i) => {
    const text = raw.replace(PREFIX, "").trim();
    if (!text.startsWith("{")) return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || !("event" in parsed)) return;
    jsonLines += 1;
    const found = [];
    for (const [rule, re] of TEXT_RULES) {
      const m = re.exec(text);
      if (m) found.push([rule, `"${m[0].slice(0, 12)}…"`]);
    }
    const opaque = longOpaque(text);
    if (opaque)
      found.push(["long opaque string", `"${opaque.slice(0, 8)}…" (${opaque.length} chars)`]);
    walk(parsed, [], found);
    for (const [rule, where] of found) findings.push({ line: i + 1, rule, where });
  });
  return { jsonLines, findings };
}

/** The request ids that appear in `api.request` lines. */
export function requestIdsLogged(lines) {
  const ids = new Set();
  for (const raw of lines) {
    const text = raw.replace(PREFIX, "").trim();
    if (!text.startsWith("{")) continue;
    try {
      const o = JSON.parse(text);
      if (typeof o.requestId === "string") ids.add(o.requestId);
    } catch {
      /* not a log line */
    }
  }
  return ids;
}
