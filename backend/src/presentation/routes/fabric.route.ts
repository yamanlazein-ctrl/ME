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
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
import { logger } from "../../infrastructure/config/logger.js";

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
      const r = await createFabricUseCase(fabricRepo, body(req), ctx(req));
      if (r.ok) {
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          try {
            const f = r.data;
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
              ctx(req),
              syncDeviceIdFromRequest(req),
              opIdFromRequest(req),
            );
          } catch (err) {
            logger.warn({ err, fabricId: r.data.id }, "sync outbox enqueue failed after fabric create");
          }
        }
        res.status(201).json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.put(
    "/inventory/fabrics/:id",
    auth,
    writeGuard,
    validateBody(updateFabricSchema),
    async (req: Request, res: Response) => {
      const r = await updateFabricUseCase(
        fabricRepo,
        pid(req),
        body<Record<string, unknown>>(req) as Record<string, unknown>,
        ctx(req),
      );
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
    const r = await deleteFabricUseCase(fabricRepo, pid(req), ctx(req));
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
