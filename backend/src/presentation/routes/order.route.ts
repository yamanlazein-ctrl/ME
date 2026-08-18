import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";
import type { IOrderRepository } from "../../application/ports/IOrderRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { createOrderSchema, updateOrderSchema, listOrdersSchema } from "./order.schema.js";
import * as uc from "../../application/use-cases/orders/orderUseCases.js";
import { nextDocumentNumber } from "../../infrastructure/utils/documentNumbers.js";

export function registerOrderRoutes(
  router: Router,
  orderRepo: IOrderRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const pid = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  router.post(
    "/orders",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(createOrderSchema),
    async (req: Request, res: Response) => {
      const r = await uc.createOrderUseCase(
        orderRepo,
        body(req),
        await nextDocumentNumber("order", ctx(req).tenantId),
        ctx(req),
      );
      if (r.ok) {
        res.status(201).json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.put(
    "/orders/:id",
    auth,
    writeGuard,
    validateUuidParam("id"),
    validateBody(updateOrderSchema),
    async (req: Request, res: Response) => {
      const r = await uc.updateOrderUseCase(
        orderRepo,
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
    "/orders",
    auth,
    readGuard,
    validateQuery(listOrdersSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listOrdersSchema>;
      const r = await uc.listOrdersUseCase(orderRepo, filter, ctx(req));
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );

  router.get("/orders/by-code", auth, readGuard, async (req: Request, res: Response) => {
    const code = String(req.query.code ?? "");
    if (!code) {
      return res.status(400).json({ code: "VALIDATION", message: "code مطلوب" });
    }
    const r = await uc.findOrderByCodeUseCase(orderRepo, code, ctx(req));
    if (!r.ok) {
      return res.status(500).json({ code: "INTERNAL", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "الطلب غير موجود" });
    }
    res.json(r.data);
  });

  router.get("/orders/:id", auth, readGuard, validateUuidParam("id"), async (req: Request, res: Response) => {
    const r = await uc.findOrderUseCase(orderRepo, pid(req), ctx(req));
    if (!r.ok) {
      return res.status(500).json({ code: "INTERNAL", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "الطلب غير موجود" });
    }
    res.json(r.data);
  });

  router.post("/orders/:id/cancel", auth, writeGuard, validateUuidParam("id"), async (req: Request, res: Response) => {
    const r = await uc.cancelOrderUseCase(orderRepo, pid(req), ctx(req));
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(422).json({ code: "VALIDATION", message: r.error });
    }
  });

  router.post("/orders/:id/fulfill", auth, writeGuard, validateUuidParam("id"), async (req: Request, res: Response) => {
    const invoiceId = (req.body as { invoiceId?: string }).invoiceId;
    if (!invoiceId) {
      return res.status(400).json({ code: "VALIDATION", message: "invoiceId مطلوب" });
    }
    const r = await uc.fulfillOrderUseCase(orderRepo, pid(req), invoiceId, ctx(req));
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(422).json({ code: "VALIDATION", message: r.error });
    }
  });
}
