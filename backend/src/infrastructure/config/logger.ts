import pino from "pino";
import { config } from "../config/env.js";

const pinoLogger = pino({
  level: config.LOG_LEVEL,
  ...(config.NODE_ENV === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
          },
        },
      }
    : {}),
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
