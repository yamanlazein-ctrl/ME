import type { Request, Response, NextFunction } from "express";
import type { TenantContext, Role } from "../../../domain/types/index.js";

// Owner decision (2026-10-12): the accountant holds every admin privilege. The only things kept for
// the admin role are granting/removing the admin role itself (user.route.ts, invitation.route.ts).
export function hasAdminPrivileges(role: Role | undefined): boolean {
  return role === "admin" || role === "accountant";
}

export function rbac(allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ctx = req.tenantContext;
    if (!ctx) {
      res
        .status(401)
        .json({ code: "UNAUTHORIZED", message: "مطلوب تسجيل الدخول", statusCode: 401 });
      return;
    }

    const allowed =
      allowedRoles.includes(ctx.userRole) ||
      (allowedRoles.includes("admin") && hasAdminPrivileges(ctx.userRole));
    if (!allowed) {
      res
        .status(403)
        .json({ code: "FORBIDDEN", message: "غير مصرح بهذا الإجراء", statusCode: 403 });
      return;
    }

    next();
  };
}
