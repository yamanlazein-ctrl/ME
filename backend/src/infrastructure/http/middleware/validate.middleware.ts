import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { ValidationError } from "../../../domain/errors/index.js";

export function validateBody<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details: Record<string, string[]> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join(".");
        details[path] = details[path] || [];
        details[path].push(issue.message);
      }
      next(new ValidationError(details));
      return;
    }
    req.validatedBody = result.data;
    next();
  };
}

export function validateQuery<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const details: Record<string, string[]> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join(".");
        details[path] = details[path] || [];
        details[path].push(issue.message);
      }
      next(new ValidationError(details));
      return;
    }
    req.validatedQuery = result.data;
    next();
  };
}
