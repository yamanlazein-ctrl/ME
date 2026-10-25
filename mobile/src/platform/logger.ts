// Replaces backend/src/infrastructure/config/logger.ts on the phone (Metro file mapping, NFR-12). The real file builds
// a `pino` logger with file transports. Same named exports; console only; no remote sink; secret-looking keys
// are redacted from logged objects.
type Fields = Record<string, unknown>;

const SECRET_KEYS = /pass(word)?|secret|token|authorization|cookie|key|pin/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  const out: Fields = Array.isArray(value) ? ({} as Fields) : {};
  for (const [k, v] of Object.entries(value as Fields)) {
    out[k] = SECRET_KEYS.test(k) ? "***" : redact(v, depth + 1);
  }
  return Array.isArray(value) ? Object.values(out) : out;
}

export interface PhoneLogger {
  fatal(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
  child(bindings: Fields): PhoneLogger;
}

function emit(method: "error" | "warn" | "info" | "debug", bindings: Fields, args: unknown[]) {
  const safe = args.map((a) => redact(a));
  const sink = console[method];
  if (Object.keys(bindings).length) sink(bindings, ...safe);
  else sink(...safe);
}

function make(bindings: Fields): PhoneLogger {
  return {
    fatal: (...a) => emit("error", bindings, a),
    error: (...a) => emit("error", bindings, a),
    warn: (...a) => emit("warn", bindings, a),
    info: (...a) => emit("info", bindings, a),
    debug: (...a) => emit("debug", bindings, a),
    trace: (...a) => emit("debug", bindings, a),
    child: (extra) => make({ ...bindings, ...extra }),
  };
}

export const LOG_REDACT_PATHS: string[] = [];

export const logger: PhoneLogger = make({});

export function logCategory(category: string, base: PhoneLogger): PhoneLogger {
  return base.child({ category });
}

export const LogCategory = {
  APP: "application",
  ERROR: "error",
  BUSINESS: "business",
  SECURITY: "security",
  AUDIT: "audit",
} as const;
