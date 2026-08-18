import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { PostgresLicenseRepository } from "../infrastructure/repositories/PostgresLicenseRepository.js";
import type { PostgresAuditRepository } from "../infrastructure/repositories/PostgresAuditRepository.js";
import type { SelfHostedLicenseProvider } from "../infrastructure/license/SelfHostedLicenseProvider.js";
import type { LicenseTokenSigner } from "../infrastructure/auth/LicenseTokenSigner.js";

/**
 * Phase 0 sub-batch 0J — public License Server v1 endpoints.
 *
 *   POST /v1/activations              — activate a license key
 *   POST /v1/activations/:id/heartbeat
 *   GET  /v1/activations/:id/devices
 *   POST /v1/activations/:id/devices  — register a device
 *   POST /v1/activations/:id/devices/:deviceId/revoke
 *   POST /v1/activations/:id/deactivate
 *
 * In a single-process deployment these are wired straight to the
 * `SelfHostedLicenseProvider` (which talks to the same DB the
 * customer install uses). In a multi-process deployment the
 * `ILicenseProvider` would be an HTTP client; the route handler is
 * the same.
 */
export function registerLicenseV1Routes(
  app: Express,
  deps: {
    licenseRepo: PostgresLicenseRepository;
    auditRepo: PostgresAuditRepository;
    licenseProvider: SelfHostedLicenseProvider;
    tokenSigner: LicenseTokenSigner;
  },
): void {
  const { licenseProvider, tokenSigner } = deps;
  void tokenSigner;

  const activateBody = z.object({
    key: z.string().min(1),
    tenantId: z.string().uuid(),
    serverFingerprint: z.string().min(1),
    serverFingerprintVersion: z.number().int().min(1),
    hostname: z.string().optional(),
    appVersion: z.string().optional(),
  });

  app.post("/v1/activations", async (req, res, next) => {
    try {
      const parsed = activateBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ code: "INVALID_REQUEST", message: "بيانات غير صالحة", statusCode: 400 });
        return;
      }
      try {
        const result = await licenseProvider.activate({
          key: parsed.data.key,
          tenantId: parsed.data.tenantId,
          serverFingerprint: parsed.data.serverFingerprint,
          serverFingerprintVersion: parsed.data.serverFingerprintVersion,
          hostname: parsed.data.hostname,
          appVersion: parsed.data.appVersion,
        });
        res.json(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "فشل التفعيل";
        const status = msg === "INVALID_LICENSE" ? 400 : msg === "ALREADY_ACTIVE" ? 409 : 500;
        res.status(status).json({ code: msg, message: msg, statusCode: status });
      }
    } catch (err) {
      next(err);
    }
  });

  app.post(
    "/v1/activations/:id/heartbeat",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await licenseProvider.refresh(String(req.params.id));
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/v1/activations/:id/devices",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const devices = await licenseProvider.listDevices(String(req.params.id));
        res.json({ devices });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/v1/activations/:id/devices/:deviceId/revoke",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const reason = String(req.body?.reason ?? "admin_revoke");
        await licenseProvider.revokeDevice(String(req.params.id), String(req.params.deviceId), reason);
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/v1/activations/:id/deactivate",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const reason = String(req.body?.reason ?? "server_deactivate");
        await licenseProvider.deactivate(String(req.params.id), reason);
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );
}
