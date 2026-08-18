import type { Request, Response, NextFunction } from "express";
import type { TenantContext, Role } from "../../../domain/types/index.js";

export function rbac(allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ctx = req.tenantContext;
    if (!ctx) {
      res
        .status(401)
        .json({ code: "UNAUTHORIZED", message: "مطلوب تسجيل الدخول", statusCode: 401 });
      return;
    }

    if (!allowedRoles.includes(ctx.userRole)) {
      res
        .status(403)
        .json({ code: "FORBIDDEN", message: "غير مصرح بهذا الإجراء", statusCode: 403 });
      return;
    }

    next();
  };
}
