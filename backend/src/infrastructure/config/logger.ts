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

const pinoLogger = pino({
  level: config.LOG_LEVEL,
  transport: {
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
  },
});

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
