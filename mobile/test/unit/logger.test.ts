import { describe, expect, it, vi } from "vitest";
import { LOG_REDACT_PATHS, LogCategory, logCategory, logger } from "../../src/platform/logger";

// Named exports of backend/src/infrastructure/config/logger.ts (evidence/T045-ports.md): logger, logCategory, LogCategory, LOG_REDACT_PATHS.
describe("phone logger", () => {
  it("provides every named export of the desktop logger file", () => {
    expect(Array.isArray(LOG_REDACT_PATHS)).toBe(true);
    expect(LogCategory.AUDIT).toBe("audit");
    for (const level of ["fatal", "error", "warn", "info", "debug", "trace", "child"] as const) {
      expect(typeof logger[level]).toBe("function");
    }
    expect(typeof logCategory("x", logger).info).toBe("function");
  });

  it("writes to the console only and redacts secrets", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logger.info({ token: "abc", name: "ok" }, "msg");
    expect(spy).toHaveBeenCalledWith({ token: "***", name: "ok" }, "msg");
    spy.mockRestore();
  });
});
