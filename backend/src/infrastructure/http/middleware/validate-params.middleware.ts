import type { Request, Response, NextFunction, RequestHandler } from "express";

// Strict RFC 4122 UUID (hex) pattern. We accept lowercase/uppercase.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Middleware factory that validates route parameter names against a UUID regex.
 * Returns 400 Bad Request (not 500) when the param is missing or malformed.
 *
 * Usage:
 *   router.get("/orders/:id", auth, readGuard, validateUuidParam("id"), handler);
 *   router.post("/orders/:id/cancel", auth, writeGuard, validateUuidParam("id"), handler);
 */
export function validateUuidParam(...paramNames: string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const name of paramNames) {
      const value = req.params[name];
      if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
        res.status(400).json({
          code: "BAD_REQUEST",
          message: `قيمة المعامل "${name}" يجب أن تكون UUID صالحاً`,
        });
        return;
      }
    }
    next();
  };
}
