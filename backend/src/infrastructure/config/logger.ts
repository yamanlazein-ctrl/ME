import { fileURLToPath } from "node:url";
import { dirname, join, resolve, isAbsolute } from "node:path";
import pino from "pino";
import { config } from "../config/env.js";

// Resolve the logs directory deterministically from this source file
// (backend/src/infrastructure/config → 4×".." = repo root), so the file lands
// in <root>/logs regardless of the process current working directory.
// LOG_DIR (optional) overrides the location — absolute or relative to root.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDir, "..", "..", "..", "..");
const logDirRaw = config.LOG_DIR ?? "logs";
const logDir = isAbsolute(logDirRaw) ? logDirRaw : join(projectRoot, logDirRaw);

// Built via pino.transport() (rather than passed inline as `pino({transport})`)
// so we get a handle to the underlying stream and can attach an error
// listener to IT — pino itself does not proxy transport/stream errors onto
// the logger instance it returns (confirmed by reading pino's source: only
// SonicBoom-family streams re-emit 'error' on themselves, nothing forwards it
// to the logger). A write failure in the worker thread (permission denied,
// disk full, AV lock) surfaces as an unhandled 'error' event on THIS stream;
// left unlistened, Node treats it as fatal and kills the whole process —
// verified live 2026-09-04 (EPERM writing to a non-writable install
// directory took down the entire backend, not just logging) and confirmed
// live again: attaching the listener to `pinoLogger` instead of the stream
// does NOT catch it (reproduced the crash 5/5 tries). A logging failure must
// never be allowed to kill the API.
const transportStream = pino.transport({
  targets: [
    {
      // Real file sink with DAILY rotation (pino-roll): the active file is
      // erp.log; old days roll to erp.YYYY-MM-DD.N.log and only the newest
      // 30 archived files are kept (limit.count) — bounded disk usage,
      // no unbounded growth. The logs/ directory is auto-created (mkdir).
      target: "pino-roll",
      options: {
        file: join(logDir, "erp.log"),
        frequency: "daily",
        limit: { count: 30, removeOtherLogFiles: true },
        mkdir: true,
      },
      level: config.LOG_LEVEL,
    },
    // Dev keeps the readable pretty console alongside the file.
    ...(config.NODE_ENV === "development"
      ? [
          {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:standard",
            },
            level: config.LOG_LEVEL,
          },
        ]
      : []),
  ],
});
transportStream.on("error", (err: unknown) => {
  console.error("[logger] transport error (non-fatal, logging degraded):", err);
});

const pinoLogger = pino({ level: config.LOG_LEVEL }, transportStream);

export { pinoLogger as logger };

export function logCategory(category: string, logger: typeof pinoLogger) {
  return logger.child({ category });
}

export const LogCategory = {
  APP: "application",
  ERROR: "error",
  BUSINESS: "business",
  SECURITY: "security",
  AUDIT: "audit",
} as const;
