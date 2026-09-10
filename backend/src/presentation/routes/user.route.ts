import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { validateBody, validateQuery } from "../../infrastructure/http/middleware/validate.middleware.js";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
import type { IUserRepository } from "../../application/ports/IUserRepository.js";
import type { TenantContext } from "../../domain/types/index.js";

const listUsersSchema = z.object({
  search: z.string().optional(),
  role: z.enum(["admin", "accountant", "warehouse", "viewer"]).optional(),
  active: z.coerce.boolean().optional(),
  page: z.coerce.number().min(0).default(0),
  limit: z.coerce.number().min(1).max(100).default(20),
});

const updateUserSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  email: z.string().email().optional(),
  role: z.enum(["admin", "accountant", "warehouse", "viewer"]).optional(),
  active: z.boolean().optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: "At least one field must be provided",
});

const resetPasswordSchema = z.object({
  password: z.string().min(6).max(128),
});

export function registerUserRoutes(
  router: Router,
  userRepo: IUserRepository,
  passwordHasher: { hash: (password: string) => Promise<string> },
  auth: RequestHandler,
  adminOnly: RequestHandler,
): void {
  const ctxFn = (req: Request): TenantContext => req.tenantContext!;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;
  const paramId = (req: Request): string => req.params.id as string;

  // GET /users — List all users for the current tenant
  router.get(
    "/users",
    auth,
    adminOnly,
    validateQuery(listUsersSchema),
    async (req: Request, res: Response) => {
      try {
        const filter = req.validatedQuery as z.infer<typeof listUsersSchema>;
        const result = await userRepo.list(filter, ctxFn(req));
        res.json(result);
      } catch (err) {
        res.status(500).json({ code: "INTERNAL", message: "خطأ في عرض المستخدمين" });
      }
    },
  );

  // GET /users/:id — Get a specific user by ID
  router.get(
    "/users/:id",
    auth,
    adminOnly,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      try {
        const user = await userRepo.findById(paramId(req), ctxFn(req));
        if (!user) {
          res.status(404).json({ code: "NOT_FOUND", message: "المستخدم غير موجود" });
          return;
        }
        res.json(user);
      } catch (err) {
        res.status(500).json({ code: "INTERNAL", message: "خطأ في عرض المستخدم" });
      }
    },
  );

  // PATCH /users/:id — Update user data (name, email, role, active)
  router.patch(
    "/users/:id",
    auth,
    adminOnly,
    validateUuidParam("id"),
    validateBody(updateUserSchema),
    async (req: Request, res: Response) => {
      try {
        const id = paramId(req);
        const adminCtx = ctxFn(req);

        // Prevent admin from deactivating themselves
        if (id === adminCtx.userId) {
          const bodyData = body<{ active?: boolean }>(req);
          if (bodyData.active === false) {
            res.status(400).json({
              code: "SELF_DEACTIVATION",
              message: "لا يمكنك تعطيل حسابك الخاص",
            });
            return;
          }
        }

        const updateData = body<z.infer<typeof updateUserSchema>>(req);
        const result = await userRepo.update(id, updateData, adminCtx);
        res.json(result);
      } catch (err) {
        if (err instanceof Error && err.message === "User not found") {
          res.status(404).json({ code: "NOT_FOUND", message: "المستخدم غير موجود" });
          return;
        }
        res.status(500).json({ code: "INTERNAL", message: "خطأ في تعديل المستخدم" });
      }
    },
  );

  // DELETE /users/:id — Soft delete (deactivate) a user
  router.delete(
    "/users/:id",
    auth,
    adminOnly,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      try {
        const id = paramId(req);
        const adminCtx = ctxFn(req);

        // Prevent admin from deleting themselves
        if (id === adminCtx.userId) {
          res.status(400).json({
            code: "SELF_DELETION",
            message: "لا يمكنك حذف حسابك الخاص",
          });
          return;
        }

        const user = await userRepo.findById(id, adminCtx);
        if (!user) {
          res.status(404).json({ code: "NOT_FOUND", message: "المستخدم غير موجود" });
          return;
        }

        await userRepo.delete(id, adminCtx);
        res.json({ ok: true, message: "تم تعطيل المستخدم بنجاح" });
      } catch (err) {
        res.status(500).json({ code: "INTERNAL", message: "خطأ في حذف المستخدم" });
      }
    },
  );

  // POST /users/:id/reset-password — Reset user password
  router.post(
    "/users/:id/reset-password",
    auth,
    adminOnly,
    validateUuidParam("id"),
    validateBody(resetPasswordSchema),
    async (req: Request, res: Response) => {
      try {
        const id = paramId(req);
        const adminCtx = ctxFn(req);
        const { password } = body<{ password: string }>(req);

        const passwordHash = await passwordHasher.hash(password);
        const result = await userRepo.update(id, { password: passwordHash }, adminCtx);
        res.json({ ok: true, message: "تم إعادة تعيين كلمة المرور بنجاح", userId: result.id });
      } catch (err) {
        if (err instanceof Error && err.message === "User not found") {
          res.status(404).json({ code: "NOT_FOUND", message: "المستخدم غير موجود" });
          return;
        }
        res.status(500).json({ code: "INTERNAL", message: "خطأ في إعادة تعيين كلمة المرور" });
      }
    },
  );
}
