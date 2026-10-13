import type { Request, Response, NextFunction } from "express";
import { logger } from "../../config/logger.js";

/**
 * aduite-12 #9: only "Request started" was logged, so a refused financial request (422/409/5xx)
 * left no trace of WHY. Log the outcome of every failed response: status, the API error `code` and
 * user-facing message, duration. Request bodies are never logged (customer data, secrets).
 */
export function logFailedResponses(req: Request, res: Response, next: NextFunction) {
  const started = Date.now();
  let errorBody: { code?: unknown; message?: unknown } | undefined;
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode >= 400 && body && typeof body === "object") {
      const b = body as { code?: unknown; message?: unknown };
      errorBody = {
        code: b.code,
        message: typeof b.message === "string" ? b.message.slice(0, 300) : undefined,
      };
    }
    return json(body);
  };
  res.on("finish", () => {
    if (res.statusCode < 400) return;
    const entry = {
      requestId: req.id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      code: errorBody?.code,
      message: errorBody?.message,
      ms: Date.now() - started,
    };
    if (res.statusCode >= 500) logger.error(entry, "Request failed");
    else logger.warn(entry, "Request refused");
  });
  next();
}
