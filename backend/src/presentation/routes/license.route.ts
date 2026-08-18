import { Router } from "express";
import { z } from "zod";
import type { Container } from "../../infrastructure/di/container.js";
import { createAuthMiddleware } from "../../infrastructure/http/middleware/auth.middleware.js";
import { rbac } from "../../infrastructure/http/middleware/rbac.middleware.js";
import {
  getCurrentLicenseUseCase,
  listDevicesUseCase,
  revokeDeviceUseCase,
  deactivateLicenseUseCase,
  activateLicenseUseCase,
} from "../../application/use-cases/license/licenseUseCases.js";
import { heartbeatUseCase } from "../../application/use-cases/license/licenseUseCases.js";

/**
 * Phase 0 sub-batch 0I — license admin routes.
 *
 *   GET  /api/license/status
 *   GET  /api/license/devices
 *   POST /api/license/devices/:deviceId/revoke
 *   POST /api/license/transfer
 *   GET  /api/license/audit
 *
 * All routes require an admin role.
 */
export function registerLicenseRoutes(
  router: Router,
  container: Container,
  authMiddleware: ReturnType<typeof createAuthMiddleware>,
): void {
  const writeGuard = rbac(["admin"]);
  const readGuard = rbac(["admin"]);

  router.get("/api/license/status", authMiddleware, readGuard, async (req, res, next) => {
    try {
      const ctx = req.tenantContext!;
      const r = await getCurrentLicenseUseCase(container.licenseRepo, container.secretsRepo, ctx);
      if (!r.ok) {
        res.status(404).json({ code: "NO_ACTIVE_LICENSE", message: r.error, statusCode: 404 });
        return;
      }
      res.json(r.data);
    } catch (err) {
      next(err);
    }
  });

  // Feature & limit flags for the UI (frozen spec §9: UI layer). All
  // authenticated tenant users may read these so the client can hide
  // modules that are not licensed. Enforcement is NOT done here — it is
  // enforced by requireFeature middleware + business-layer limit checks.
  router.get("/api/license/features", authMiddleware, async (req, res, next) => {
    try {
      const ctx = req.tenantContext!;
      const lic = await container.licenseRepo.findLatestForTenant(ctx.tenantId as never);
      if (!lic) {
        res
          .status(404)
          .json({ code: "NO_ACTIVE_LICENSE", message: "لا يوجد ترخيص نشط", statusCode: 404 });
        return;
      }
      res.json({
        plan: lic.plan,
        edition: lic.edition,
        licenseModel: lic.licenseModel,
        licenseVersion: lic.licenseVersion,
        productVersion: lic.productVersion,
        bindingType: lic.bindingType,
        features: lic.features,
        limits: lic.limits,
        transferPolicy: lic.transferPolicy,
        updatePolicy: lic.updatePolicy,
        backupPolicy: lic.backupPolicy,
      });
    } catch (err) {
      next(err);
    }
  });

  // R2/R16: customer-backend activation endpoint (post-setup re-activation /
  // license transfer by an authenticated admin). The server fingerprint is
  // computed server-side and combined with the stable installation id so
  // transfers to a new host are supported.
  router.post("/api/license/activate", authMiddleware, writeGuard, async (req, res, next) => {
    try {
      const ctx = req.tenantContext!;
      const fingerprintInput = await container.fingerprintProvider.collect();
      const metadata = await container.fingerprintProvider.getMetadata(fingerprintInput);
      const installationId = await container.installationIdStorage.readOrCreate();
      const combined = `${metadata.hash}::${installationId}`;
      const r = await activateLicenseUseCase(container.licenseProvider, container.secretsRepo, {
        key: String(req.body?.key ?? ""),
        tenantId: ctx.tenantId,
        serverFingerprint: combined,
        hostname: req.body?.hostname,
        appVersion: req.body?.appVersion,
      });
      if (!r.ok) {
        const msg = r.error;
        const status =
          msg === "INVALID_LICENSE" ? 400 : msg === "LICENSE_BOUND_TO_ANOTHER_TENANT" ? 409 : 500;
        res.status(status).json({ code: "ACTIVATION_FAILED", message: msg, statusCode: status });
        return;
      }
      res.json(r.data);
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/license/devices", authMiddleware, readGuard, async (req, res, next) => {
    try {
      const ctx = req.tenantContext!;
      const r = await listDevicesUseCase(container.licenseProvider, container.licenseRepo, ctx);
      if (!r.ok) {
        res.status(404).json({ code: "NOT_FOUND", message: r.error, statusCode: 404 });
        return;
      }
      res.json({ devices: r.data });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/api/license/devices/:deviceId/revoke",
    authMiddleware,
    writeGuard,
    async (req, res, next) => {
      try {
        const ctx = req.tenantContext!;
        const reason = String(req.body?.reason ?? "admin_action");
        const r = await revokeDeviceUseCase(
          container.licenseProvider,
          container.licenseRepo,
          container.secretsRepo,
          container.tokenDenylist,
          ctx,
          String(req.params.deviceId),
          reason,
        );
        if (!r.ok) {
          res.status(404).json({ code: "NOT_FOUND", message: r.error, statusCode: 404 });
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post("/api/license/transfer", authMiddleware, writeGuard, async (req, res, next) => {
    try {
      const ctx = req.tenantContext!;
      const reason = String(req.body?.reason ?? "transfer");
      const r = await deactivateLicenseUseCase(
        container.licenseProvider,
        container.licenseRepo,
        container.secretsRepo,
        container.tokenDenylist,
        ctx,
        reason,
      );
      if (!r.ok) {
        res.status(404).json({ code: "NOT_FOUND", message: r.error, statusCode: 404 });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/license/heartbeat", authMiddleware, readGuard, async (req, res, next) => {
    try {
      const ctx = req.tenantContext!;
      const r = await heartbeatUseCase(
        container.licenseProvider,
        container.licenseRepo,
        ctx,
        container.fingerprintProvider,
      );
      if (!r.ok) {
        res.status(503).json({ code: "HEARTBEAT_FAILED", message: r.error, statusCode: 503 });
        return;
      }
      res.json(r.data);
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/license/audit", authMiddleware, readGuard, async (req, res, next) => {
    try {
      const ctx = req.tenantContext!;
      const page = Math.max(1, Number(req.query.page ?? 1));
      const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50)));
      const result = await container.licenseRepo.listEvents(
        { tenantId: ctx.tenantId as never },
        { page, pageSize },
      );
      res.json({ events: result.data, total: result.total, page, pageSize });
    } catch (err) {
      next(err);
    }
  });
}
