import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";
import type { IRollRepository } from "../../application/ports/IRollRepository.js";
import type { IStockMovementRepository } from "../../application/ports/IStockMovementRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { createRollSchema, updateRollSchema, listRollsSchema } from "./roll.schema.js";
import {
  createRollUseCase,
  updateRollUseCase,
  findRollUseCase,
  listRollsUseCase,
  deleteRollUseCase,
} from "../../application/use-cases/inventory/rollUseCases.js";
import type { ISyncOutboxRepository } from "../../application/ports/ISyncOutboxRepository.js";
import {
  enqueueMasterCreate,
  enqueueMasterDelete,
  enqueueMasterUpdate,
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
import { logger } from "../../infrastructure/config/logger.js";
import { withTenantTx } from "../../infrastructure/orm/drizzle.js";

export function registerRollRoutes(
  router: Router,
  rollRepo: IRollRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
  stockMovementRepo?: IStockMovementRepository,
  syncOutboxRepo?: ISyncOutboxRepository,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const pid = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  // F04 (Phase 1 audit): this route had no idempotency protection at all — a
  // retried/double-submitted request created a second, genuinely orphaned
  // roll row (the only guard was a unique (tenant, rollNo) index, which does
  // not catch a retry that lands a different auto-generated rollNo). The
  // frontend's HTTP client already generates and reuses an Idempotency-Key
  // per logical mutation (BaseHttpClient.ts, BUG-16 fix) — this route just
  // never honored it. Same middleware already used on cashbox manual
  // movements for the identical reason.
  router.post(
    "/inventory/rolls",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(createRollSchema),
    async (req: Request, res: Response) => {
      const c = ctx(req);
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());

      // F-07: the roll and its outbox unit share ONE transaction.
      const runCreate = async () => {
        const created = await createRollUseCase(rollRepo, body(req), c);
        if (!created.ok) return created;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          const roll = created.data;
          await enqueueMasterCreate(
            syncOutboxRepo,
            "roll",
            roll.id,
            {
              id: roll.id,
              colorId: roll.colorId,
              rollNo: roll.rollNo,
              dyeBatch: roll.dyeBatch ?? null,
              initialKg: roll.initialKg,
              remainingKg: roll.remainingKg,
              pieces: roll.pieces,
              remainingPieces: roll.remainingPieces,
              pricePerKg: roll.pricePerKg,
              salePricePerKg: roll.salePricePerKg ?? null,
              currency: roll.currency,
              supplierId: roll.supplierId ?? null,
              entryDate: roll.entryDate,
              widthCm: roll.widthCm ?? null,
              weightGsm: roll.weightGsm ?? null,
              status: roll.status,
            },
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
          );
        }
        return created;
      };

      let r: Awaited<ReturnType<typeof createRollUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runCreate) : await runCreate();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — roll create dropped (F-07)");
        return res.status(500).json({
          code: "SYNC_OUTBOX_FAILED",
          message: "تعذّر حفظ الصبغة مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
          statusCode: 500,
        });
      }

      if (r.ok) {
        res.status(201).json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  // SYNC-13: roll updates/deletes enqueue sync units in the same
  // transaction (F-07 pattern); rolls carry a version column for the
  // stale-base guard. NOTE: stock-quantity edits to a roll replay as master
  // updates, NOT as stock claims — quantity mutations belong to documents.
  router.put(
    "/inventory/rolls/:id",
    auth,
    writeGuard,
    validateBody(updateRollSchema),
    async (req: Request, res: Response) => {
      const c = ctx(req);
      const id = pid(req);
      const input = body<Record<string, unknown>>(req) as Record<string, unknown>;
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());
      const runUpdate = async () => {
        const before = await rollRepo.findById(id, c);
        const r = await updateRollUseCase(rollRepo, id, input, c);
        if (!r.ok) return r;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueMasterUpdate(
            syncOutboxRepo,
            "roll",
            id,
            input,
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
            { version: (before as unknown as { version?: number } | null)?.version ?? null },
          );
        }
        return r;
      };
      let r: Awaited<ReturnType<typeof updateRollUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runUpdate) : await runUpdate();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — roll update dropped (F-07)");
        return res.status(500).json({ code: "INTERNAL", message: "فشل تحديث اللفافة" });
      }
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.get(
    "/inventory/rolls",
    auth,
    readGuard,
    validateQuery(listRollsSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listRollsSchema>;
      const r = await listRollsUseCase(rollRepo, filter, ctx(req));
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );

  router.delete("/inventory/rolls/:id", auth, writeGuard, async (req: Request, res: Response) => {
    const c = ctx(req);
    const id = pid(req);
    const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());
    const runDelete = async () => {
      // 4D: base read in the same transaction as the delete (see fabric route).
      const before = await rollRepo.findById(id, c);
      const r = await deleteRollUseCase(rollRepo, id, c);
      if (!r.ok || !r.data) return r;
      if (syncOutboxRepo && isSyncEnqueueEnabled()) {
        await enqueueMasterDelete(
          syncOutboxRepo,
          "roll",
          id,
          c,
          syncDeviceIdFromRequest(req),
          opIdFromRequest(req),
          { version: before?.version ?? null, updatedAt: before?.updatedAt ?? null },
        );
      }
      return r;
    };
    let r: Awaited<ReturnType<typeof deleteRollUseCase>>;
    try {
      r = syncEnabled ? await withTenantTx(c.tenantId, runDelete) : await runDelete();
    } catch (err) {
      logger.error({ err }, "transaction rolled back — roll delete dropped (F-07)");
      return res.status(500).json({ code: "INTERNAL", message: "فشل حذف اللفافة" });
    }
    if (!r.ok) {
      return res.status(422).json({ code: "VALIDATION", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "الصبغة غير موجودة" });
    }
    res.status(204).send();
  });

  router.get(
    "/inventory/rolls/:id",
    auth,
    readGuard,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      const r = await findRollUseCase(rollRepo, pid(req), ctx(req));
      if (!r.ok) {
        return res.status(500).json({ code: "INTERNAL", message: r.error });
      }
      if (!r.data) {
        return res.status(404).json({ code: "NOT_FOUND", message: "الصبغة غير موجودة" });
      }
      res.json(r.data);
    },
  );

  router.get(
    "/inventory/rolls/:id/movements",
    auth,
    readGuard,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      if (!stockMovementRepo) {
        return res
          .status(501)
          .json({ code: "NOT_IMPLEMENTED", message: "سجل حركات المخزون غير مفعّل" });
      }
      const q = req.query as Record<string, string>;
      const filter = {
        movementType: q.movementType,
        fromDate: q.fromDate,
        toDate: q.toDate,
        limit: q.limit ? Number(q.limit) : undefined,
      };
      try {
        const rows = await stockMovementRepo.listByRoll(pid(req) as string, ctx(req), filter);
        res.json({ data: rows });
      } catch (e) {
        res.status(500).json({
          code: "INTERNAL",
          message: e instanceof Error ? e.message : "فشل جلب حركات المخزون",
        });
      }
    },
  );
}
