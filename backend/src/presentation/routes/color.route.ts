import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";
import type { IColorRepository } from "../../application/ports/IColorRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { createColorSchema, updateColorSchema, listColorsSchema } from "./color.schema.js";
import {
  createColorUseCase,
  updateColorUseCase,
  findColorUseCase,
  listColorsUseCase,
  deleteColorUseCase,
} from "../../application/use-cases/inventory/colorUseCases.js";
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

export function registerColorRoutes(
  router: Router,
  colorRepo: IColorRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
  syncOutboxRepo?: ISyncOutboxRepository,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const pid = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  router.post(
    "/inventory/colors",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(createColorSchema),
    async (req: Request, res: Response) => {
      const c = ctx(req);
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());

      // F-07: the color and its outbox unit share ONE transaction.
      const runCreate = async () => {
        const created = await createColorUseCase(colorRepo, body(req), c);
        if (!created.ok) return created;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          const col = created.data;
          await enqueueMasterCreate(
            syncOutboxRepo,
            "color",
            col.id,
            {
              id: col.id,
              fabricId: col.fabricId,
              name: col.name,
              code: col.code ?? null,
              hex: col.hex ?? null,
              imageUrl: col.imageUrl ?? null,
            },
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
          );
        }
        return created;
      };

      let r: Awaited<ReturnType<typeof createColorUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runCreate) : await runCreate();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — color create dropped (F-07)");
        return res.status(500).json({
          code: "SYNC_OUTBOX_FAILED",
          message: "تعذّر حفظ اللون مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
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

  // SYNC-13: color updates/deletes enqueue sync units in the same
  // transaction (F-07 pattern); pre-edit updatedAt is the stale-base guard.
  router.put(
    "/inventory/colors/:id",
    auth,
    writeGuard,
    validateBody(updateColorSchema),
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
        const before = await colorRepo.findById(id, c);
        const r = await updateColorUseCase(colorRepo, id, input, c, expectedVersion);
        if (!r.ok) return r;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueMasterUpdate(
            syncOutboxRepo,
            "color",
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
      let r: Awaited<ReturnType<typeof updateColorUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runUpdate) : await runUpdate();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — color update dropped (F-07)");
        return res.status(500).json({ code: "INTERNAL", message: "فشل تحديث اللون" });
      }
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.get(
    "/inventory/colors",
    auth,
    readGuard,
    validateQuery(listColorsSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listColorsSchema>;
      const r = await listColorsUseCase(colorRepo, filter, ctx(req));
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );

  router.delete("/inventory/colors/:id", auth, writeGuard, async (req: Request, res: Response) => {
    const c = ctx(req);
    const id = pid(req);
    const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());
    const runDelete = async () => {
      // 4D: base read in the same transaction as the delete (see fabric route).
      const before = await colorRepo.findById(id, c);
      const r = await deleteColorUseCase(colorRepo, id, c);
      if (!r.ok || !r.data) return r;
      if (syncOutboxRepo && isSyncEnqueueEnabled()) {
        await enqueueMasterDelete(
          syncOutboxRepo,
          "color",
          id,
          c,
          syncDeviceIdFromRequest(req),
          opIdFromRequest(req),
          { version: before?.version ?? null, updatedAt: before?.updatedAt ?? null },
        );
      }
      return r;
    };
    let r: Awaited<ReturnType<typeof deleteColorUseCase>>;
    try {
      r = syncEnabled ? await withTenantTx(c.tenantId, runDelete) : await runDelete();
    } catch (err) {
      logger.error({ err }, "transaction rolled back — color delete dropped (F-07)");
      return res.status(500).json({ code: "INTERNAL", message: "فشل حذف اللون" });
    }
    if (!r.ok) {
      return res.status(422).json({ code: "VALIDATION", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "اللون غير موجود" });
    }
    res.status(204).send();
  });

  router.get("/inventory/colors/:id", auth, readGuard, async (req: Request, res: Response) => {
    const r = await findColorUseCase(colorRepo, pid(req), ctx(req));
    if (!r.ok) {
      return res.status(500).json({ code: "INTERNAL", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "اللون غير موجود" });
    }
    res.json(r.data);
  });
}
