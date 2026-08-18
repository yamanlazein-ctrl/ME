import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Container } from "../../infrastructure/di/container.js";
import { createAuthMiddleware } from "../../infrastructure/http/middleware/auth.middleware.js";
import { rbac } from "../../infrastructure/http/middleware/rbac.middleware.js";

/**
 * Phase 0 sub-batch 0H — company profile routes.
 *
 *   GET  /api/company/profile       — read current profile
 *   PUT  /api/company/profile       — upsert profile
 *   POST /api/company/logo         — upload logo (multipart, file field "logo")
 *
 * The logo upload writes to `/var/lib/erp/logos/<tenantId>/<uuid>.<ext>`
 * (configurable via the COMPANy_LOGO_DIR env). For Phase 0 we do
 * not implement multer — the route reads the raw body and parses
 * `Content-Disposition`. A future iteration should switch to a
 * proper multipart parser.
 */
const companyBody = z.object({
  name: z.string().min(1),
  commercialReg: z.string().optional(),
  taxNumber: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  currency: z.string().length(3).optional(),
  language: z.string().min(2).max(5).optional(),
  fiscalYearStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  defaultTaxRate: z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/)
    .optional(),
});

export function registerCompanyRoutes(
  router: Router,
  container: Container,
  authMiddleware: ReturnType<typeof createAuthMiddleware>,
): void {
  const writeGuard = rbac(["admin"]);
  const readGuard = rbac(["admin", "accountant", "warehouse", "viewer"]);

  router.get("/api/company/profile", authMiddleware, readGuard, async (req, res, next) => {
    try {
      const ctx = req.tenantContext!;
      const profile = await container.companyRepo.findByTenant(ctx.tenantId);
      res.json(profile ?? null);
    } catch (err) {
      next(err);
    }
  });

  router.put("/api/company/profile", authMiddleware, writeGuard, async (req, res, next) => {
    try {
      const ctx = req.tenantContext!;
      const parsed = companyBody.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(422)
          .json({ code: "VALIDATION_ERROR", message: "بيانات غير صالحة", statusCode: 422 });
        return;
      }
      const profile = await container.companyRepo.upsert({
        tenantId: ctx.tenantId as never,
        ...parsed.data,
      });
      res.json(profile);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/company/logo — Phase 0 minimal version: accepts a
  // JSON body { dataUrl: "data:image/png;base64,..." } and writes
  // it to disk. A real multipart parser is planned for 0K.
  router.post("/api/company/logo", authMiddleware, writeGuard, async (req, res, next) => {
    try {
      const ctx = req.tenantContext!;
      const dataUrl = String(req.body?.dataUrl ?? "");
      const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) {
        res
          .status(422)
          .json({ code: "VALIDATION_ERROR", message: "dataUrl غير صالح", statusCode: 422 });
        return;
      }
      const ext = match[1] === "jpeg" ? "jpg" : match[1]!;
      const buffer = Buffer.from(match[2]!, "base64");
      const dir = process.env.COMPANY_LOGO_DIR ?? "/var/lib/erp/logos";
      const path = join(dir, ctx.tenantId, `${randomUUID()}.${ext}`);
      await mkdir(join(dir, ctx.tenantId), { recursive: true });
      await writeFile(path, buffer);
      await container.companyRepo.setLogoPath(ctx.tenantId, path);
      res.json({ logoPath: path });
    } catch (err) {
      next(err);
    }
  });
}
