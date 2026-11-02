import { redact } from "./redact";

/**
 * Structured server logger (PRD 11.6): one JSON line per event, with identifiers and counts, never record contents.
 * Everything passes through `redact`, so even a careless call cannot print a token, a cookie, a note or an e-mail.
 *
 *   logger.info("api.request", { requestId, route, status, durationMs, orgId, userId });
 *   logger.error("api.unhandled_error", { requestId, error });
 *   const log = logger.child({ requestId });
 *
 * Do not use `console.*` in server code (ESLint enforces it): it bypasses redaction.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
/** `silent` (LOG_LEVEL=silent) writes nothing: for test runs. */
type Threshold = LogLevel | "silent";
const ORDER: Record<Threshold, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Fields the logger is designed for. Anything else is allowed, redacted, and should be a count or a code. */
export type LogFields = {
  requestId?: string;
  route?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  orgId?: string;
  userId?: string;
  errorCode?: string;
  error?: unknown;
  count?: number;
  [field: string]: unknown;
};

export type LogSink = (level: LogLevel, line: string) => void;

export type Logger = {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
};

const defaultSink: LogSink = (level, line) => {
  // stdout/stderr directly: platform log collectors read both, and `console.*` is banned in server code.
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
};

function levelFromEnv(): Threshold {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" || raw === "silent"
    ? raw
    : "info";
}

export type LoggerOptions = {
  sink?: LogSink;
  level?: Threshold;
  now?: () => Date;
  bound?: LogFields;
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const { sink = defaultSink, now = () => new Date(), bound = {} } = options;
  const emit = (level: LogLevel, event: string, fields?: LogFields) => {
    // An injected sink (a test, a custom destination) is a deliberate choice: it sees everything unless a level is given.
    if (ORDER[level] < ORDER[options.level ?? (options.sink ? "debug" : levelFromEnv())]) return;
    try {
      const safe = redact({ ...bound, ...fields }) as Record<string, unknown>;
      // `level`, `event` and `ts` are set last so a field cannot overwrite them.
      sink(
        level,
        JSON.stringify({
          ...safe,
          ts: now().toISOString(),
          level,
          event: String(event).slice(0, 100),
        }),
      );
    } catch {
      // logging must never break a request
    }
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    child: (fields) => createLogger({ ...options, bound: { ...bound, ...fields } }),
  };
}

/** The process-wide logger. */
export const logger: Logger = createLogger();
