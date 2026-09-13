import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";
import type { IFabricRepository } from "../../application/ports/IFabricRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { createFabricSchema, updateFabricSchema, listFabricsSchema } from "./fabric.schema.js";
import {
  createFabricUseCase,
  updateFabricUseCase,
  findFabricUseCase,
  listFabricsUseCase,
  deleteFabricUseCase,
} from "../../application/use-cases/inventory/fabricUseCases.js";
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

export function registerFabricRoutes(
  router: Router,
  fabricRepo: IFabricRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
  syncOutboxRepo?: ISyncOutboxRepository,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const pid = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  router.post(
    "/inventory/fabrics",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(createFabricSchema),
    async (req: Request, res: Response) => {
      const c = ctx(req);
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());

      // F-07: the fabric and its outbox unit share ONE transaction.
      const runCreate = async () => {
        const created = await createFabricUseCase(fabricRepo, body(req), c);
        if (!created.ok) return created;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          const f = created.data;
          await enqueueMasterCreate(
            syncOutboxRepo,
            "fabric",
            f.id,
            {
              id: f.id,
              name: f.name,
              category: f.category ?? null,
              minStockKg: f.minStockKg,
              unit: f.unit ?? null,
              notes: f.notes ?? null,
              imageUrl: f.imageUrl ?? null,
            },
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
          );
        }
        return created;
      };

      let r: Awaited<ReturnType<typeof createFabricUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runCreate) : await runCreate();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — fabric create dropped (F-07)");
        return res.status(500).json({
          code: "SYNC_OUTBOX_FAILED",
          message: "تعذّر حفظ القماش مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
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

  // SYNC-13: fabric updates/deletes enqueue sync units in the same
  // transaction (F-07 pattern). Fabrics carry no version column, so the
  // pre-edit updatedAt is captured as the stale-base guard.
  router.put(
    "/inventory/fabrics/:id",
    auth,
    writeGuard,
    validateBody(updateFabricSchema),
    async (req: Request, res: Response) => {
      const c = ctx(req);
      const id = pid(req);
      const input = body<Record<string, unknown>>(req) as Record<string, unknown>;
      const expectedVersion = req.body?.expectedVersion;
      if (typeof expectedVersion !== "number") {
        return res.status(400).json({ code: "EXPECTED_VERSION_REQUIRED", message: "الإصدار المتوقع (expectedVersion) مطلوب للتحديث/الإلغاء" });
      }
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());
      const runUpdate = async () => {
        const before = await fabricRepo.findById(id, c);
        const r = await updateFabricUseCase(fabricRepo, id, input, c, expectedVersion);
        if (!r.ok) return r;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueMasterUpdate(
            syncOutboxRepo,
            "fabric",
            id,
            input,
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
            {
              updatedAt: (before as unknown as { updatedAt?: string } | null)?.updatedAt ?? null,
            },
          );
        }
        return r;
      };
      let r: Awaited<ReturnType<typeof updateFabricUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runUpdate) : await runUpdate();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — fabric update dropped (F-07)");
        return res.status(500).json({ code: "INTERNAL", message: "فشل تحديث القماش" });
      }
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.get(
    "/inventory/fabrics",
    auth,
    readGuard,
    validateQuery(listFabricsSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listFabricsSchema>;
      const r = await listFabricsUseCase(fabricRepo, filter, ctx(req));
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );

  router.delete("/inventory/fabrics/:id", auth, writeGuard, async (req: Request, res: Response) => {
    const c = ctx(req);
    const id = pid(req);
    const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());
    const runDelete = async () => {
      // 4D: read the base in the same transaction as the delete, so the
      // enqueued unit carries the version the deletion is based on and the hub
      // can refuse a stale replay instead of destroying a newer edit.
      const before = await fabricRepo.findById(id, c);
      const r = await deleteFabricUseCase(fabricRepo, id, c);
      if (!r.ok || !r.data) return r;
      if (syncOutboxRepo && isSyncEnqueueEnabled()) {
        await enqueueMasterDelete(
          syncOutboxRepo,
          "fabric",
          id,
          c,
          syncDeviceIdFromRequest(req),
          opIdFromRequest(req),
          { version: before?.version ?? null, updatedAt: before?.updatedAt ?? null },
        );
      }
      return r;
    };
    let r: Awaited<ReturnType<typeof deleteFabricUseCase>>;
    try {
      r = syncEnabled ? await withTenantTx(c.tenantId, runDelete) : await runDelete();
    } catch (err) {
      logger.error({ err }, "transaction rolled back — fabric delete dropped (F-07)");
      return res.status(500).json({ code: "INTERNAL", message: "فشل حذف القماش" });
    }
    if (!r.ok) {
      return res.status(422).json({ code: "VALIDATION", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "النسيج غير موجود" });
    }
    res.status(204).send();
  });

  router.get("/inventory/fabrics/:id", auth, readGuard, async (req: Request, res: Response) => {
    const r = await findFabricUseCase(fabricRepo, pid(req), ctx(req));
    if (!r.ok) {
      return res.status(500).json({ code: "INTERNAL", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "القماش غير موجود" });
    }
    res.json(r.data);
  });
}
