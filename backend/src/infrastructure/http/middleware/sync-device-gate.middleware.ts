import type { Request, Response, NextFunction } from "express";
import type { ISyncDeviceRepository } from "../../../application/ports/ISyncDeviceRepository.js";
import type { TenantContext } from "../../../domain/types/index.js";
import { logger } from "../../config/logger.js";

/**
 * Sync device trust gate (Batch 4 / item 4B).
 *
 * Device identity on the sync surface is SELF-ASSERTED: a client sends
 * `X-Sync-Device-Id` (or a `syncDeviceId` field in the push/claim body) and the
 * hub decides whether to believe it. Registration alone used to be the only
 * check, which left three holes this gate closes:
 *
 *   1. `findById` accepted ANY registered device of the tenant, so a valid
 *      session for user A could push as device D of user B (forged device id).
 *   2. There was no revocation, so a decommissioned/stolen device kept its
 *      authority forever (requirement: revoked device).
 *   3. Nothing tied the acting user to the device, so attribution had no
 *      authority behind it.
 *
 * The gate resolves the asserted device id, loads it in the caller's tenant
 * (RLS + explicit tenant filter), and refuses with a DISTINCT code so the
 * device can distinguish "register me" from "I was revoked" from "not yours".
 * A request that asserts no device is left alone: unattributed local flows are
 * an explicitly supported state (push with `syncDeviceId: null`), and they gain
 * no device authority — every unit is still materialized tenant-scoped.
 */
export type SyncDeviceGatePolicy = {
  /**
   * "reject": an id that is not registered for this tenant is refused
   * (attribution is required for the operation to mean anything — hub push
   * ingestion, device-scoped number blocks, pull).
   * "allow": an unknown id passes; per-unit gating still happens at the hub.
   * Used for the local `/sync/run` orchestration trigger, where "not yet
   * registered" is a legitimate client state.
   */
  unknownDevice: "reject" | "allow";
  /** "reject": only users bound to the device may assert it. */
  unboundUser: "reject" | "allow";
  /**
   * Whether the `excludeSyncDeviceId` query parameter counts as the caller
   * asserting its own device. Only the hub's pull endpoint uses it that way.
   */
  assertFromQuery?: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

export function createSyncDeviceGate(
  syncDeviceRepo: ISyncDeviceRepository,
  policy: SyncDeviceGatePolicy,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ctx = req.tenantContext;
    if (!ctx) {
      res.status(401).json({ code: "UNAUTHORIZED", message: "مطلوب تسجيل الدخول", statusCode: 401 });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const asserted =
      asUuid(body.syncDeviceId) ??
      asUuid(ctx.syncDeviceId) ??
      (policy.assertFromQuery ? asUuid(req.query.excludeSyncDeviceId) : null);

    // No device asserted: unattributed local flow. Allowed by design — it
    // carries no device authority.
    if (!asserted) {
      next();
      return;
    }

    const deny = (status: number, code: string, message: string) => {
      logger.warn(
        {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          syncDeviceId: asserted,
          path: req.path,
          method: req.method,
          code,
        },
        "sync device gate refused request",
      );
      res.status(status).json({ code, message, statusCode: status });
    };

    const device = await syncDeviceRepo.findById(ctx.tenantId, asserted);
    if (!device) {
      if (policy.unknownDevice === "reject") {
        deny(
          403,
          "SYNC_UNKNOWN_DEVICE",
          "الجهاز غير مسجّل لدى المركز — سجّل الجهاز أولاً ثم أعد المحاولة",
        );
        return;
      }
      next();
      return;
    }

    if (device.revokedAt) {
      deny(
        403,
        "SYNC_DEVICE_REVOKED",
        "الجهاز مُلغى من المركز — أعِد تسجيل الجهاز بعد مراجعة المسؤول",
      );
      return;
    }

    if (policy.unboundUser === "reject" && !device.authorizedUserIds.includes(ctx.userId)) {
      deny(
        403,
        "SYNC_DEVICE_NOT_BOUND",
        "هذا الجهاز غير مرتبط بحسابك — سجّل الجهاز من حسابك ثم أعد المحاولة",
      );
      return;
    }

    next();
  };
}

/** Helper for routes that must tenant-scope the context themselves. */
export type SyncDeviceGateContext = Pick<TenantContext, "tenantId" | "userId" | "syncDeviceId">;
