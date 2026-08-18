import type { Request, Response, NextFunction } from "express";
import { DomainError, ValidationError, AuthError } from "../../../domain/errors/index.js";
import type { Logger } from "pino";

export function createErrorHandler(logger: Logger) {
  return (err: Error, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ValidationError) {
      res.status(422).json({
        code: err.code,
        message: err.message,
        statusCode: 422,
        details: err.details,
      });
      return;
    }

    if (err instanceof AuthError) {
      const statusCode = err.code === "FORBIDDEN" ? 403 : 401;
      res.status(statusCode).json({
        code: err.code,
        message: err.message,
        statusCode,
      });
      return;
    }

    if (err instanceof DomainError) {
      const statusMap: Record<string, number> = {
        NOT_FOUND: 404,
        CONFLICT: 409,
        CONCURRENT_MODIFICATION: 409,
        INSUFFICIENT_STOCK: 422,
        INVALID_STATE: 422,
        DAY_LOCKED: 422,
        DUPLICATE: 422,
        RATE_LIMIT_EXCEEDED: 429,
      };
      const statusCode = statusMap[err.code] || 422;
      res.status(statusCode).json({
        code: err.code,
        message: err.message,
        statusCode,
      });
      return;
    }

    logger.error({ err, requestId: req.id, path: req.path, method: req.method }, "Unhandled error");
    res.status(500).json({
      code: "INTERNAL_ERROR",
      message: "حدث خطأ داخلي. يرجى المحاولة لاحقاً.",
      statusCode: 500,
    });
  };
}
