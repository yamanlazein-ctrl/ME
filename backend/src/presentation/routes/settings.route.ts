import type { Router, Request, Response, RequestHandler } from "express";
import type { ISettingsRepository } from "../../application/ports/ISettingsRepository.js";
import type { ISyncOutboxRepository } from "../../application/ports/ISyncOutboxRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { logger } from "../../infrastructure/config/logger.js";
import { withTenantTx } from "../../infrastructure/orm/drizzle.js";
import {
  enqueueSettingsUpdate,
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
import * as uc from "../../application/use-cases/settings/settingsUseCases.js";
import { Settings } from "../../domain/entities/Settings.js";

export function registerSettingsRoutes(
  router: Router,
  settingsRepo: ISettingsRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
  syncOutboxRepo?: ISyncOutboxRepository,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;

  router.get("/settings", auth, readGuard, async (req: Request, res: Response) => {
    const r = await uc.getSettingsUseCase(settingsRepo, ctx(req));
    if (r.ok) {
      res.json(r.data ?? Settings.createDefault(ctx(req).tenantId).toData());
    } else {
      res.status(500).json({ code: "INTERNAL", message: r.error });
    }
  });

  // SYNC-13: admin snapshots sync hub-wins (no claims). The write and its
  // outbox unit share one transaction (F-07 pattern).
  router.put("/settings/:section", auth, writeGuard, async (req: Request, res: Response) => {
    const section = req.params.section as string;
    if (
      ![
        "company",
        "currencies",
        "paymentMethods",
        "taxes",
        "units",
        "warehouses",
        "printing",
      ].includes(section)
    ) {
      return res.status(400).json({ code: "VALIDATION", message: "قسم غير صالح" });
    }
    const c = ctx(req);
    const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());
    const runUpdate = async () => {
      const r = await uc.updateSettingsUseCase(settingsRepo, section, req.body, c);
      if (!r.ok) return r;
      if (syncOutboxRepo && isSyncEnqueueEnabled()) {
        await enqueueSettingsUpdate(
          syncOutboxRepo,
          section,
          req.body as Record<string, unknown>,
          (r.data as unknown as { updatedAt?: string })?.updatedAt ?? new Date().toISOString(),
          c,
          syncDeviceIdFromRequest(req),
          opIdFromRequest(req),
        );
      }
      return r;
    };
    let r: Awaited<ReturnType<typeof uc.updateSettingsUseCase>>;
    try {
      r = syncEnabled ? await withTenantTx(c.tenantId, runUpdate) : await runUpdate();
    } catch (err) {
      logger.error({ err }, "transaction rolled back — settings update dropped (F-07)");
      return res.status(500).json({ code: "INTERNAL", message: "فشل تحديث الإعدادات" });
    }
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(422).json({ code: "VALIDATION", message: r.error });
    }
  });
}
