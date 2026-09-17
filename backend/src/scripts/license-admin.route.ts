import type { Express, Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { PostgresLicenseRepository } from "../infrastructure/repositories/PostgresLicenseRepository.js";
import type { PostgresAuditRepository } from "../infrastructure/repositories/PostgresAuditRepository.js";
import type { JwtSigner } from "../infrastructure/auth/JwtSigner.js";
import type { PostgresSystemAdminRepository } from "../infrastructure/repositories/PostgresSystemAdminRepository.js";
import type { Argon2PasswordHasher } from "../infrastructure/auth/PasswordHasher.js";
import type { TokenDenylist } from "../infrastructure/auth/TokenDenylist.js";
import { superAdminLoginUseCase } from "../application/use-cases/super-admin/superAdminUseCases.js";
import {
  resolveFeatures,
  defaultLimits,
  isPlan,
  isEdition,
  type Plan,
} from "../domain/licensing/plans.js";
import { resolveDeviceLimit } from "../domain/licensing/ownership.js";
import { syncTenantLicenseCacheFromLicenseRow } from "../infrastructure/license/syncTenantLicenseCache.js";
import { refreshOfflineEntitlement } from "../infrastructure/license/refreshOfflineEntitlement.js";
import type { ILicenseTokenSigner } from "../application/ports/ILicenseTokenSigner.js";
import type { ISecretsRepository } from "../application/ports/ISecretsRepository.js";
import type { ISecretCipher } from "../application/ports/ISecretCipher.js";
import type { DB } from "../infrastructure/orm/drizzle.js";

/**
 * Phase 4 — license admin API (frozen spec §2.1, §6).
 *
 *   POST /license-admin/login            (public)  — Super Admin login → JWT
 *   GET  /license-admin/licenses         (admin)   — list
 *   POST /license-admin/licenses         (admin)   — create (edition/plan/limits/policies)
 *   GET  /license-admin/activations      (admin)   — list activations
 *   POST /license-admin/activations/:id/deactivate (admin) — deactivate
 *
 * Admin auth is the Super Admin JWT (role "super_admin"); a static
 * LICENSE_ADMIN_TOKEN is accepted as a backward-compatible fallback.
 */
export function registerLicenseAdminRoutes(
  app: Express,
  deps: {
    licenseRepo: PostgresLicenseRepository;
    auditRepo: PostgresAuditRepository;
    jwtSigner: JwtSigner;
    adminAuth: (req: Request, res: Response, next: NextFunction) => void;
    systemAdminRepo: PostgresSystemAdminRepository;
    passwordHasher: Argon2PasswordHasher;
    tokenDenylist: TokenDenylist;
    /** License Server always has a private key; used to re-sign offline grants. */
    licenseTokenSigner?: ILicenseTokenSigner;
    /** Optional — when License Server shares APP_MASTER_KEY + DB with ERP. */
    secretsRepo?: ISecretsRepository;
    secretCipher?: ISecretCipher;
    db?: DB;
  },
): void {
  const {
    licenseRepo,
    auditRepo,
    jwtSigner,
    adminAuth,
    systemAdminRepo,
    passwordHasher,
    tokenDenylist,
    licenseTokenSigner,
    secretCipher,
    secretsRepo,
  } = deps;

  // ── Public: Super Admin login ──────────────────────────────────────
  app.post("/license-admin/login", async (req, res, next) => {
    try {
      const r = await superAdminLoginUseCase(
        systemAdminRepo,
        passwordHasher,
        jwtSigner,
        tokenDenylist,
        req.body,
      );
      if (!r.ok) {
        res.status(401).json({ code: "AUTH_FAILED", message: r.error, statusCode: 401 });
        return;
      }
      res.json(r.data);
    } catch (err) {
      next(err);
    }
  });

  app.get("/license-admin/licenses", adminAuth, async (_req, res, next) => {
    try {
      const list = await licenseRepo.list({});
      res.json({ licenses: list });
    } catch (err) {
      next(err);
    }
  });

  const limitsSchema = z.object({
    users: z.number().int().min(0).default(0),
    devices: z.number().int().min(0).default(0),
    branches: z.number().int().min(0).default(0),
    warehouses: z.number().int().min(0).default(0),
    storage_gb: z.number().min(0).default(0),
    api_calls: z.number().int().min(0).default(0),
  });
  const transferPolicySchema = z.object({
    allowed: z.boolean().default(true),
    max_transfers: z.number().int().min(0).default(3),
    requires_super_admin: z.boolean().default(true),
  });
  const updatePolicySchema = z.object({
    channel: z.enum(["stable", "beta", "none"]).default("stable"),
    allow_updates: z.boolean().default(true),
    minimum_version: z.string().default("1.0.0"),
  });
  const backupPolicySchema = z.object({
    enabled: z.boolean().default(true),
    cloud_backup: z.boolean().default(false),
    max_backups: z.number().int().min(0).default(30),
  });

  const createBody = z
    .object({
      key: z.string().min(8).optional(),
      type: z.enum(["trial", "full", "subscription"]).default("full"),
      status: z.enum(["active", "suspended", "expired", "revoked"]).default("active"),
      // ── License Engine inputs (frozen spec §3, §5) ──
      edition: z.string().min(1),
      plan: z.string().min(1),
      licenseVersion: z.string().default("v1"),
      productVersion: z.string().optional(),
      licenseModel: z.enum(["perpetual", "subscription"]).default("perpetual"),
      bindingType: z.enum(["machine", "server", "none", "account"]).default("machine"),
      bindingValue: z.string().optional(),
      featureAdd: z.array(z.string()).default([]),
      featureRemove: z.array(z.string()).default([]),
      limits: limitsSchema.optional(),
      transferPolicy: transferPolicySchema.optional(),
      updatePolicy: updatePolicySchema.optional(),
      backupPolicy: backupPolicySchema.optional(),
      expiresAt: z.string().datetime().optional(),
      companyName: z.string().optional(),
      // ── Customer directory fields (Phase ب) — real columns ──
      customerName: z.string().max(200).optional(),
      customerPhone: z.string().max(40).optional(),
      customerNotes: z.string().max(2000).optional(),
      maxDevices: z.number().int().min(1).max(100).default(3),
      graceDays: z.number().int().min(0).max(60).default(7),
    })
    .refine((v) => isPlan(v.plan), { message: "خطة غير صالحة", path: ["plan"] })
    .refine((v) => isEdition(v.edition), { message: "إصدار غير صالح", path: ["edition"] });

  app.post("/license-admin/licenses", adminAuth, async (req, res, next) => {
    try {
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(422)
          .json({ code: "VALIDATION_ERROR", message: "بيانات غير صالحة", statusCode: 422 });
        return;
      }
      const d = parsed.data;

      // Plan is the template; the resolved feature list is the source of truth.
      const features = resolveFeatures(d.plan as Plan, {
        add: d.featureAdd,
        remove: d.featureRemove,
      });
      const baseLimits = d.limits ?? defaultLimits(d.plan as Plan);
      // Control Plane SoT: keep max_devices column and limits.devices identical.
      const deviceLimit = resolveDeviceLimit({
        limits: baseLimits,
        maxDevices: d.maxDevices,
      });
      const limits = { ...baseLimits, devices: deviceLimit };

      const { db } = await import("../infrastructure/orm/drizzle.js");
      const { licenses } = await import("../infrastructure/orm/schemas/license.table.js");
      const [row] = await db
        .insert(licenses)
        .values({
          key: d.key ?? `LIC-${randomBytes(12).toString("hex").toUpperCase()}`,
          type: d.type,
          status: d.status,
          expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
          graceDays: d.graceDays,
          maxDevices: deviceLimit,
          features,
          vendorMetadata: d.companyName ? { companyName: d.companyName } : null,
          // Customer directory columns. `customerName` falls back to
          // `companyName` so the single name field always lands in a real
          // column, not just in vendor_metadata.
          customerName: d.customerName ?? d.companyName ?? null,
          customerPhone: d.customerPhone ?? null,
          customerNotes: d.customerNotes ?? null,
          // Engine fields
          edition: d.edition,
          plan: d.plan,
          licenseVersion: d.licenseVersion,
          productVersion: d.productVersion ?? null,
          licenseModel: d.licenseModel,
          bindingType: d.bindingType,
          bindingValue: d.bindingValue ?? null,
          limits,
          transferPolicy: d.transferPolicy ?? {
            allowed: true,
            max_transfers: 3,
            requires_super_admin: true,
          },
          updatePolicy: d.updatePolicy ?? {
            channel: "stable",
            allow_updates: true,
            minimum_version: "1.0.0",
          },
          backupPolicy: d.backupPolicy ?? { enabled: true, cloud_backup: false, max_backups: 30 },
        })
        .returning();
      res.json({ license: row });
    } catch (err) {
      next(err);
    }
  });

  app.get("/license-admin/activations", adminAuth, async (_req, res, next) => {
    try {
      const { db } = await import("../infrastructure/orm/drizzle.js");
      const { licenseActivations } =
        await import("../infrastructure/orm/schemas/license-activation.table.js");
      const rows = await db.select().from(licenseActivations);
      res.json({ activations: rows });
    } catch (err) {
      next(err);
    }
  });

  app.post("/license-admin/activations/:id/deactivate", adminAuth, async (req, res, next) => {
    try {
      const { db } = await import("../infrastructure/orm/drizzle.js");
      const { licenseActivations } =
        await import("../infrastructure/orm/schemas/license-activation.table.js");
      const { eq } = await import("drizzle-orm");
      const reason = String(req.body?.reason ?? "admin_deactivation");
      const [row] = await db
        .update(licenseActivations)
        .set({ deactivatedAt: new Date(), deactivationReason: reason })
        .where(eq(licenseActivations.id, req.params.id as never))
        .returning();
      res.json({ activation: row });
      void auditRepo;
    } catch (err) {
      next(err);
    }
  });

  /**
   * Vendor Control Plane — mutate License rights (status / limits).
   * Customer ERP must never expose equivalent mutations.
   */
  const patchLicenseBody = z.object({
    status: z.enum(["active", "suspended", "expired", "revoked"]).optional(),
    limits: limitsSchema.partial().optional(),
    updatePolicy: updatePolicySchema.partial().optional(),
    graceDays: z.number().int().min(0).max(60).optional(),
    customerName: z.string().max(200).optional(),
    customerPhone: z.string().max(40).optional(),
    customerNotes: z.string().max(2000).optional(),
  });

  app.patch("/license-admin/licenses/:id", adminAuth, async (req, res, next) => {
    try {
      const parsed = patchLicenseBody.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(422)
          .json({ code: "VALIDATION_ERROR", message: "بيانات غير صالحة", statusCode: 422 });
        return;
      }
      const { db } = await import("../infrastructure/orm/drizzle.js");
      const { licenses } = await import("../infrastructure/orm/schemas/license.table.js");
      const { eq } = await import("drizzle-orm");
      const id = String(req.params.id);
      const [current] = await db.select().from(licenses).where(eq(licenses.id, id as never)).limit(1);
      if (!current) {
        res.status(404).json({ code: "NOT_FOUND", message: "الترخيص غير موجود", statusCode: 404 });
        return;
      }
      const patch = parsed.data;
      const nextLimits = patch.limits
        ? { ...(current.limits as Record<string, number>), ...patch.limits }
        : (current.limits as Record<string, number>);
      const deviceLimit = resolveDeviceLimit({
        limits: nextLimits as { devices?: number },
        maxDevices: current.maxDevices,
      });
      const limits = { ...nextLimits, devices: deviceLimit };
      const nextUpdatePolicy = patch.updatePolicy
        ? {
            ...(current.updatePolicy as Record<string, unknown>),
            ...patch.updatePolicy,
          }
        : current.updatePolicy;
      const [row] = await db
        .update(licenses)
        .set({
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.graceDays !== undefined ? { graceDays: patch.graceDays } : {}),
          ...(patch.customerName !== undefined ? { customerName: patch.customerName } : {}),
          ...(patch.customerPhone !== undefined ? { customerPhone: patch.customerPhone } : {}),
          ...(patch.customerNotes !== undefined ? { customerNotes: patch.customerNotes } : {}),
          ...(patch.updatePolicy ? { updatePolicy: nextUpdatePolicy } : {}),
          limits,
          maxDevices: deviceLimit,
          updatedAt: new Date(),
        })
        .where(eq(licenses.id, id as never))
        .returning();
      if (row) {
        await syncTenantLicenseCacheFromLicenseRow(db, row);
        if (licenseTokenSigner) {
          const refresh = await refreshOfflineEntitlement({
            db,
            signer: licenseTokenSigner,
            license: row as never,
            secretsRepo: secretsRepo ?? null,
            cipher: secretCipher ?? null,
            tokenDenylist,
          });
          res.json({ license: row, entitlementRefresh: refresh });
          return;
        }
      }
      res.json({ license: row });
    } catch (err) {
      next(err);
    }
  });

  app.post("/license-admin/licenses/:id/suspend", adminAuth, async (req, res, next) => {
    try {
      const { db } = await import("../infrastructure/orm/drizzle.js");
      const { licenses } = await import("../infrastructure/orm/schemas/license.table.js");
      const { eq } = await import("drizzle-orm");
      const id = String(req.params.id);
      const [row] = await db
        .update(licenses)
        .set({ status: "suspended", updatedAt: new Date() })
        .where(eq(licenses.id, id as never))
        .returning();
      if (!row) {
        res.status(404).json({ code: "NOT_FOUND", message: "الترخيص غير موجود", statusCode: 404 });
        return;
      }
      await syncTenantLicenseCacheFromLicenseRow(db, row);
      let entitlementRefresh = undefined;
      if (licenseTokenSigner) {
        entitlementRefresh = await refreshOfflineEntitlement({
          db,
          signer: licenseTokenSigner,
          license: row as never,
          secretsRepo: secretsRepo ?? null,
          cipher: secretCipher ?? null,
          tokenDenylist,
        });
      }
      res.json({ license: row, entitlementRefresh });
    } catch (err) {
      next(err);
    }
  });
}
