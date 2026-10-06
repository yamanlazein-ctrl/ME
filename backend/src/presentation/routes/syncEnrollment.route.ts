import type { Router, Request, Response } from "express";
import { z } from "zod";
import { validateBody } from "../../infrastructure/http/middleware/validate.middleware.js";
import type { Container } from "../../infrastructure/di/container.js";
import {
  exchangeDeviceToken,
  redeemEnrollmentCode,
  type Failure,
} from "../../application/use-cases/sync/syncEnrollment.js";
import { logger } from "../../infrastructure/config/logger.js";

const EnrollSchema = z.object({
  code: z.string().trim().min(6).max(32),
  device: z.object({
    id: z.string().uuid(),
    fingerprint: z.string().min(8).max(128),
    fingerprintVersion: z.number().int().min(1).max(10).optional(),
    platform: z.string().min(1).max(16),
    hostname: z.string().max(120).optional(),
    label: z.string().max(120).optional(),
  }),
});

const DeviceTokenSchema = z.object({
  tenantId: z.string().uuid(),
  deviceId: z.string().uuid(),
  secret: z.string().min(20).max(200),
});

const send = (res: Response, r: Failure) =>
  res.status(r.status).json({ code: r.code, message: r.error, statusCode: r.status });

/**
 * Hub, pre-auth: a device has no hub session yet (enroll) or its session
 * expired (device-token). Both authenticate by secret, not by account.
 * Mounted at the root router, `/api` prefix hard-coded like auth/invitations.
 */
export function registerSyncEnrollmentPublicRoutes(router: Router, container: Container) {
  router.post("/api/sync/enroll", validateBody(EnrollSchema), async (req: Request, res: Response, next) => {
    try {
      const body = (req as unknown as { validatedBody: z.infer<typeof EnrollSchema> }).validatedBody;
      // A hub install is one company (same resolution as hub login).
      const tenantId =
        process.env.BOOTSTRAP_TENANT_ID ?? (await container.installationStateRepo.findAnyCompleted());
      if (!tenantId) {
        res.status(503).json({ code: "SETUP_REQUIRED", message: "المركز لم يُكمل الإعداد", statusCode: 503 });
        return;
      }
      const r = await redeemEnrollmentCode(container, tenantId, body.code, body.device);
      if (!r.ok) {
        logger.warn({ code: r.code, deviceId: body.device.id }, "device enrollment refused");
        return send(res, r);
      }
      logger.info({ tenantId, deviceId: r.deviceId }, "device enrolled with company code");
      res.status(201).json(r);
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/sync/device-token", validateBody(DeviceTokenSchema), async (req: Request, res: Response, next) => {
    try {
      const body = (req as unknown as { validatedBody: z.infer<typeof DeviceTokenSchema> }).validatedBody;
      const r = await exchangeDeviceToken(container, body.tenantId, body.deviceId, body.secret);
      if (!r.ok) return send(res, r);
      res.json(r);
    } catch (err) {
      next(err);
    }
  });
}
