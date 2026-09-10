import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { validateBody } from "../../infrastructure/http/middleware/validate.middleware.js";
import type { Container } from "../../infrastructure/di/container.js";
import * as syncUc from "../../application/use-cases/sync/syncUseCases.js";
import * as numberBlocksUc from "../../application/use-cases/sync/numberBlockUseCases.js";
import { logger } from "../../infrastructure/config/logger.js";
import { BusinessRuleError } from "../../domain/errors/index.js";

const PushUnitSchema = z.object({
  opId: z.string().uuid(),
  syncDeviceId: z.string().uuid().nullable().optional(),
  entityType: z.string().min(1).max(40),
  entityId: z.string().uuid(),
  operation: z.string().min(1).max(20),
  payload: z.record(z.unknown()),
});

const ClaimBlockSchema = z.object({
  syncDeviceId: z.string().uuid(),
  entityType: z.string().min(1).max(30),
  size: z.number().int().min(1).max(5000).optional(),
});

const EnsureBlocksSchema = z.object({
  syncDeviceId: z.string().uuid(),
  entityTypes: z.array(z.string().min(1).max(30)).optional(),
});

const ReclaimBlockSchema = z.object({
  blockId: z.string().uuid(),
});

export function registerSyncRoutes(
  router: Router,
  container: Container,
  auth: RequestHandler,
) {
  router.get("/sync/status", auth, async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    const status = await syncUc.getSyncStatus(container.syncOutboxRepo, ctx.tenantId);
    res.json(status);
  });

  router.get("/sync/pending", auth, async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    const rows = await container.syncOutboxRepo.listPending(ctx.tenantId, 100);
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        opId: r.opId,
        entityType: r.entityType,
        entityId: r.entityId,
        operation: r.operation,
        status: r.status,
        createdAt: r.createdAt,
      })),
    });
  });

  /** Push local outbox to hub, then pull peers' applied units. */
  router.post("/sync/run", auth, async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    const push = await syncUc.runLocalSyncPush(
      container.syncOutboxRepo,
      container.invoiceRepo,
      container.auditRepo,
      container.notificationRepo,
      ctx,
      req.headers.authorization,
    );

    let pull = { pulled: 0, applied: 0, skipped: 0, failed: 0 };
    try {
      pull = await syncUc.runLocalSyncPull(
        container.db,
        {
          invoiceRepo: container.invoiceRepo,
          voucherRepo: container.voucherRepo,
          returnRepo: container.returnRepo,
          orderRepo: container.orderRepo,
          expenseRepo: container.expenseRepo,
          auditRepo: container.auditRepo,
        },
        ctx,
        req.headers.authorization,
        ctx.syncDeviceId ?? null,
      );
    } catch (err) {
      logger.warn({ err }, "sync pull during sync/run failed");
    }

    // Best-effort: refill number blocks while online.
    if (ctx.syncDeviceId) {
      try {
        await numberBlocksUc.ensureDeviceNumberBlocks(
          container.documentNumberBlockRepo,
          container.fingerprintProvider,
          {
            tenantId: ctx.tenantId,
            syncDeviceId: ctx.syncDeviceId,
            userId: ctx.userId,
            authHeader: req.headers.authorization,
          },
        );
      } catch (err) {
        logger.warn({ err }, "number-block ensure during sync/run failed");
      }
    }
    res.json({ ...push, pull });
  });

  /**
   * Hub endpoint: FWW claims + use-case replay (PRE_ALLOCATED invoice create).
   */
  router.post(
    "/sync/push",
    auth,
    validateBody(PushUnitSchema),
    async (req: Request, res: Response) => {
      const ctx = req.tenantContext!;
      const body = (req as unknown as { validatedBody: z.infer<typeof PushUnitSchema> })
        .validatedBody;
      try {
        const result = await syncUc.receiveSyncPush(
          container.syncInboxRepo,
          container.syncResourceClaimRepo,
          container.notificationRepo,
          {
            invoiceRepo: container.invoiceRepo,
            voucherRepo: container.voucherRepo,
            returnRepo: container.returnRepo,
            orderRepo: container.orderRepo,
            expenseRepo: container.expenseRepo,
            auditRepo: container.auditRepo,
          },
          container.db,
          {
            tenantId: ctx.tenantId,
            syncDeviceId: body.syncDeviceId,
            opId: body.opId,
            entityType: body.entityType,
            entityId: body.entityId,
            operation: body.operation,
            payload: body.payload as Record<string, unknown>,
            hubCtx: ctx,
          },
        );
        if (!result.accepted) {
          res.status(409).json({
            accepted: false,
            code: "SYNC_CONFLICT",
            message: result.message,
            conflictOpId: result.conflictOpId,
            conflicts: result.conflicts,
            inboxId: result.row.id,
            opId: result.row.opId,
            status: result.row.status,
          });
          return;
        }
        res.status(result.created ? 201 : 200).json({
          accepted: true,
          created: result.created,
          materialized: result.materialized,
          inboxId: result.row.id,
          opId: result.row.opId,
          status: result.row.status,
        });
      } catch (err) {
        logger.error({ err }, "sync push receive failed");
        res.status(500).json({ code: "SYNC_PUSH_FAILED", message: "فشل استلام وحدة المزامنة" });
      }
    },
  );

  /** Hub → peer: list applied sync units after a cursor. */
  router.get("/sync/pull", auth, async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    const afterRaw = typeof req.query.after === "string" ? req.query.after : null;
    const after = afterRaw ? new Date(afterRaw) : null;
    if (afterRaw && Number.isNaN(after?.getTime())) {
      res.status(400).json({ code: "BAD_REQUEST", message: "after يجب أن يكون ISO datetime" });
      return;
    }
    const exclude =
      typeof req.query.excludeSyncDeviceId === "string" ? req.query.excludeSyncDeviceId : null;
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;

    const rows = await container.syncInboxRepo.listAppliedSince(ctx.tenantId, after, {
      excludeSyncDeviceId: exclude && /^[0-9a-f-]{36}$/i.test(exclude) ? exclude : null,
      limit,
    });
    res.json({
      items: rows.map((r) => ({
        opId: r.opId,
        syncDeviceId: r.syncDeviceId,
        entityType: r.entityType,
        entityId: r.entityId,
        operation: r.operation,
        payload: r.payload,
        receivedAt: r.receivedAt.toISOString(),
        appliedAt: r.appliedAt?.toISOString() ?? null,
      })),
    });
  });

  /** Claim a reserved number block for a sync device (hub or local authority). */
  router.post(
    "/sync/number-blocks/claim",
    auth,
    validateBody(ClaimBlockSchema),
    async (req: Request, res: Response) => {
      const ctx = req.tenantContext!;
      const body = (req as unknown as { validatedBody: z.infer<typeof ClaimBlockSchema> })
        .validatedBody;
      try {
        const block = await numberBlocksUc.claimNumberBlock({
          tenantId: ctx.tenantId,
          syncDeviceId: body.syncDeviceId,
          entityType: body.entityType,
          size: body.size,
        });
        res.status(201).json({
          ...block,
          preAllocated: true,
        });
      } catch (err) {
        if (err instanceof BusinessRuleError) {
          res.status(422).json({ code: "BUSINESS_RULE", message: err.message });
          return;
        }
        logger.error({ err }, "number-block claim failed");
        res.status(500).json({ code: "NUMBER_BLOCK_CLAIM_FAILED", message: "فشل حجز كتلة الترقيم" });
      }
    },
  );

  /** Ensure active blocks exist (local claim or hub proxy). */
  router.post(
    "/sync/number-blocks/ensure",
    auth,
    validateBody(EnsureBlocksSchema),
    async (req: Request, res: Response) => {
      const ctx = req.tenantContext!;
      const body = (req as unknown as { validatedBody: z.infer<typeof EnsureBlocksSchema> })
        .validatedBody;
      try {
        const result = await numberBlocksUc.ensureDeviceNumberBlocks(
          container.documentNumberBlockRepo,
          container.fingerprintProvider,
          {
            tenantId: ctx.tenantId,
            syncDeviceId: body.syncDeviceId,
            userId: ctx.userId,
            authHeader: req.headers.authorization,
            entityTypes: body.entityTypes,
          },
        );
        res.json(result);
      } catch (err) {
        if (err instanceof BusinessRuleError) {
          res.status(422).json({ code: "BUSINESS_RULE", message: err.message });
          return;
        }
        logger.error({ err }, "number-block ensure failed");
        res.status(500).json({
          code: "NUMBER_BLOCK_ENSURE_FAILED",
          message: "فشل تجهيز كتل الترقيم",
        });
      }
    },
  );

  router.get("/sync/number-blocks", auth, async (req: Request, res: Response) => {
    const ctx = req.tenantContext!;
    const deviceId =
      (typeof req.query.syncDeviceId === "string" && req.query.syncDeviceId) ||
      ctx.syncDeviceId ||
      null;
    if (!deviceId) {
      res.status(400).json({ code: "SYNC_DEVICE_REQUIRED", message: "معرّف جهاز المزامنة مطلوب" });
      return;
    }
    const rows = await container.documentNumberBlockRepo.listForDevice(ctx.tenantId, deviceId);
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        entityType: r.entityType,
        year: r.year,
        prefix: r.prefix,
        startNumber: r.startNumber,
        endNumber: r.endNumber,
        nextNumber: r.nextNumber,
        remaining: Math.max(0, r.endNumber - r.nextNumber + 1),
        status: r.status,
        claimedAt: r.claimedAt,
      })),
    });
  });

  router.post(
    "/sync/number-blocks/reclaim",
    auth,
    validateBody(ReclaimBlockSchema),
    async (req: Request, res: Response) => {
      const ctx = req.tenantContext!;
      const body = (req as unknown as { validatedBody: z.infer<typeof ReclaimBlockSchema> })
        .validatedBody;
      try {
        const result = await numberBlocksUc.reclaimNumberBlock({
          tenantId: ctx.tenantId,
          blockId: body.blockId,
        });
        res.json(result);
      } catch (err) {
        if (err instanceof BusinessRuleError) {
          res.status(422).json({ code: "BUSINESS_RULE", message: err.message });
          return;
        }
        logger.error({ err }, "number-block reclaim failed");
        res.status(500).json({
          code: "NUMBER_BLOCK_RECLAIM_FAILED",
          message: "فشل استرداد ذيل الكتلة",
        });
      }
    },
  );
}
