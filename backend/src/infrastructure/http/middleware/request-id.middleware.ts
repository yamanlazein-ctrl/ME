import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = (req.headers["x-request-id"] as string) || randomUUID();
  req.id = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
}
