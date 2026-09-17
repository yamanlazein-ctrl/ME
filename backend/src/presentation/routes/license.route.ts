import { Router } from "express";
import type { Container } from "../../infrastructure/di/container.js";
import { createAuthMiddleware } from "../../infrastructure/http/middleware/auth.middleware.js";
import { rbac } from "../../infrastructure/http/middleware/rbac.middleware.js";
import {
  getCurrentLicenseUseCase,
  listDevicesUseCase,
  revokeDeviceUseCase,
  activateLicenseUseCase,
  ACTIVATION_ERRORS,
} from "../../application/use-cases/license/licenseUseCases.js";
import { heartbeatUseCase } from "../../application/use-cases/license/licenseUseCases.js";
import { composeDeviceFingerprint } from "../../domain/licensing/installationIdentity.js";
import { ensureServerInstallation } from "../../infrastructure/installation/ensureServerInstallation.js";
import { evaluateUpdateEligibility } from "../../domain/licensing/updatePolicyGate.js";
import type { UpdateChannel } from "../../domain/licensing/license-metadata.js";

/**
 * Customer-org + local entitlement routes.
 *
 * Control Plane ownership:
 *   - Org MAY: read status/features, list devices, revoke a DeviceSeat,
 *     heartbeat, read audit (local), activate a key when no active license.
 *   - Vendor ONLY: transfer / deactivate entitlement, change plan/features/
 *     limits/status. Those live on `/license-admin/*` (License Server).
 *
 *   GET  /api/license/status
 *   GET  /api/license/devices          (also /api/org/devices)
 *   POST /api/license/devices/:id/revoke  (also /api/org/devices/:id/revoke)
 *   POST /api/license/transfer         → 403 VENDOR_ONLY
 *   GET  /api/license/audit
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
      const currentVersion =
        typeof req.query.currentVersion === "string" ? req.query.currentVersion : undefined;
      const updateGate = evaluateUpdateEligibility(currentVersion, lic.updatePolicy);
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
        updateGate,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Update Control Plane (read for customer / enforce for desktop shell).
   * Publishing CDN artifacts stays vendor-side; this only applies license policy.
   */
  router.get("/api/license/updates/status", authMiddleware, async (req, res, next) => {
    try {
      const ctx = req.tenantContext!;
      const lic = await container.licenseRepo.findLatestForTenant(ctx.tenantId as never);
      if (!lic) {
        res
          .status(404)
          .json({ code: "NO_ACTIVE_LICENSE", message: "لا يوجد ترخيص نشط", statusCode: 404 });
        return;
      }
      const currentVersion =
        typeof req.query.currentVersion === "string" ? req.query.currentVersion : "0.0.0";
      const channelRaw = typeof req.query.channel === "string" ? req.query.channel : null;
      const preferredChannel =
        channelRaw === "stable" || channelRaw === "beta" || channelRaw === "none"
          ? (channelRaw as UpdateChannel)
          : null;
      const gate = evaluateUpdateEligibility(currentVersion, lic.updatePolicy, preferredChannel);
      res.json({
        currentVersion,
        ...gate,
        // Hint for desktop: only call Tauri updater when mayCheckForUpdates.
        updaterEndpointHint: "https://updates.motardfabrics.com/desktop/latest.json",
      });
    } catch (err) {
      next(err);
    }
  });

  // R2/R16: redeem a license key when this tenant has no active activation.
  // Re-binding / transferring an already-active entitlement is Vendor-only
  // (Control Plane) — customer admins manage DeviceSeats, not License rights.
  router.post("/api/license/activate", authMiddleware, writeGuard, async (req, res, next) => {
    try {
      const ctx = req.tenantContext!;
      const existing = await container.licenseRepo.findActiveForTenant(ctx.tenantId as never);
      if (existing) {
        const activation = await container.licenseRepo.findActiveActivationForLicense(
          existing.id as never,
        );
        if (activation) {
          res.status(403).json({
            code: "VENDOR_ONLY",
            message:
              "نقل أو إعادة ربط الترخيص النشط من صلاحيات المورد فقط — ألغِ جهازاً من قائمة الأجهزة أو تواصل مع المورد لنقل التثبيت",
            statusCode: 403,
            action: "license.transfer",
          });
          return;
        }
      }
      const fingerprintInput = await container.fingerprintProvider.collect();
      const metadata = await container.fingerprintProvider.getMetadata(fingerprintInput);
      const installationId = await container.installationIdStorage.readOrCreate();
      const combined = composeDeviceFingerprint(metadata.hash, installationId);
      const r = await activateLicenseUseCase(container.licenseProvider, container.secretsRepo, {
        key: String(req.body?.key ?? ""),
        tenantId: ctx.tenantId,
        serverFingerprint: combined,
        hostname: req.body?.hostname,
        appVersion: req.body?.appVersion,
        // Reported by the client shell (Tauri desktop / mobile / browser) so
        // the device row records the real platform instead of a fixed value.
        platform: req.body?.platform,
      });
      if (!r.ok) {
        const msg = r.error;
        // Conflict for capacity/binding refusals, 400 for a bad key, 500 otherwise.
        const status =
          msg === ACTIVATION_ERRORS.DEVICE_LIMIT_REACHED || msg === ACTIVATION_ERRORS.ALREADY_ACTIVE
            ? 409
            : msg === ACTIVATION_ERRORS.INVALID_LICENSE
              ? 400
              : msg === ACTIVATION_ERRORS.LICENSE_REVOKED ||
                  msg === ACTIVATION_ERRORS.LICENSE_EXPIRED
                ? 403
                : 500;
        res.status(status).json({ code: "ACTIVATION_FAILED", message: msg, statusCode: status });
        return;
      }
      await ensureServerInstallation(container.db, {
        installationId,
        tenantId: ctx.tenantId,
        hostname: typeof req.body?.hostname === "string" ? req.body.hostname : null,
        appVersion: typeof req.body?.appVersion === "string" ? req.body.appVersion : null,
      });
      res.json(r.data);
    } catch (err) {
      next(err);
    }
  });

  const listDevicesHandler = async (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
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
  };

  router.get("/api/license/devices", authMiddleware, readGuard, listDevicesHandler);
  // Org-plane alias — same DeviceSeat list (customer manages seats within Max Devices).
  router.get("/api/org/devices", authMiddleware, readGuard, listDevicesHandler);

  const revokeDeviceHandler = async (
    req: import("express").Request,
    res: import("express").Response,
    next: import("express").NextFunction,
  ) => {
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
  };

  router.post(
    "/api/license/devices/:deviceId/revoke",
    authMiddleware,
    writeGuard,
    revokeDeviceHandler,
  );
  router.post("/api/org/devices/:deviceId/revoke", authMiddleware, writeGuard, revokeDeviceHandler);

  // Vendor Control Plane only — customer org must not deactivate entitlement.
  router.post("/api/license/transfer", authMiddleware, writeGuard, async (_req, res) => {
    res.status(403).json({
      code: "VENDOR_ONLY",
      message:
        "نقل أو إلغاء تفعيل الترخيص من صلاحيات المورد فقط — استخدم لوحة إدارة التراخيص (Control Plane)",
      statusCode: 403,
      action: "license.transfer",
    });
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
