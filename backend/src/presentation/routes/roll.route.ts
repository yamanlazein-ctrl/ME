import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
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

export function registerRollRoutes(
  router: Router,
  rollRepo: IRollRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
  stockMovementRepo?: IStockMovementRepository,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const pid = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  router.post(
    "/inventory/rolls",
    auth,
    writeGuard,
    validateBody(createRollSchema),
    async (req: Request, res: Response) => {
      const r = await createRollUseCase(rollRepo, body(req), ctx(req));
      if (r.ok) {
        res.status(201).json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.put(
    "/inventory/rolls/:id",
    auth,
    writeGuard,
    validateBody(updateRollSchema),
    async (req: Request, res: Response) => {
      const r = await updateRollUseCase(
        rollRepo,
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
    const r = await deleteRollUseCase(rollRepo, pid(req), ctx(req));
    if (!r.ok) {
      return res.status(422).json({ code: "VALIDATION", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "الصبغة غير موجودة" });
    }
    res.status(204).send();
  });

  router.get("/inventory/rolls/:id", auth, readGuard, validateUuidParam("id"), async (req: Request, res: Response) => {
    const r = await findRollUseCase(rollRepo, pid(req), ctx(req));
    if (!r.ok) {
      return res.status(500).json({ code: "INTERNAL", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "الصبغة غير موجودة" });
    }
    res.json(r.data);
  });

  router.get(
    "/inventory/rolls/:id/movements",
    auth,
    readGuard,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      if (!stockMovementRepo) {
        return res.status(501).json({ code: "NOT_IMPLEMENTED", message: "سجل حركات المخزون غير مفعّل" });
      }
      const q = (req.query as Record<string, string>);
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
        res.status(500).json({ code: "INTERNAL", message: e instanceof Error ? e.message : "فشل جلب حركات المخزون" });
      }
    },
  );
}
