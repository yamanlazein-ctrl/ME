import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";
import type { IOrderRepository } from "../../application/ports/IOrderRepository.js";
import type { ISyncOutboxRepository } from "../../application/ports/ISyncOutboxRepository.js";
import type { IPartyRepository } from "../../application/ports/IPartyRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import type { CreateOrderInput } from "../../domain/entities/Order.js";
import { createOrderSchema, updateOrderSchema, listOrdersSchema, pendingConflictsSchema } from "./order.schema.js";
import * as uc from "../../application/use-cases/orders/orderUseCases.js";
import { nextDocumentNumber } from "../../infrastructure/utils/documentNumbers.js";
import {
  enqueueOrderCancel,
  enqueueOrderCreate,
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
import type { InvoiceSyncDependencies } from "../../application/use-cases/sync/syncDependencySnapshots.js";
import { logger } from "../../infrastructure/config/logger.js";

export function registerOrderRoutes(
  router: Router,
  orderRepo: IOrderRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
  syncOutboxRepo?: ISyncOutboxRepository,
  partyRepo?: IPartyRepository,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const pid = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  async function partyDeps(
    partyId: string | undefined,
    tenantCtx: TenantContext,
  ): Promise<InvoiceSyncDependencies | null> {
    if (!partyRepo || !partyId) return null;
    const p = await partyRepo.findById(partyId, tenantCtx);
    if (!p) return null;
    return {
      parties: [
        {
          id: p.id,
          kind: p.kind,
          code: p.code ?? null,
          name: p.name,
          companyName: p.companyName ?? null,
          commercialReg: p.commercialReg ?? null,
          category: p.category ?? null,
          salesRep: p.salesRep ?? null,
          phone: p.phone ?? null,
          mobile: p.mobile ?? null,
          whatsapp: p.whatsapp ?? null,
          altPhone: p.altPhone ?? null,
          email: p.email ?? null,
          website: p.website ?? null,
          address: p.address ?? null,
          city: p.city ?? null,
          country: p.country ?? null,
          taxNumber: p.taxNumber ?? null,
          currency: p.currency,
          paymentTerms: p.paymentTerms ?? null,
          paymentMethod: p.paymentMethod ?? null,
          defaultDiscount: p.defaultDiscount,
          vat: p.vat,
          status: p.status,
          notes: p.notes ?? null,
        },
      ],
      fabrics: [],
      colors: [],
      rolls: [],
    };
  }

  router.post(
    "/orders",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(createOrderSchema),
    async (req: Request, res: Response) => {
      const input = body<CreateOrderInput>(req);
      const r = await uc.createOrderUseCase(
        orderRepo,
        input,
        await nextDocumentNumber("order", ctx(req).tenantId),
        ctx(req),
      );
      if (r.ok) {
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          try {
            await enqueueOrderCreate(
              syncOutboxRepo,
              { id: r.data.id, code: r.data.code },
              input,
              ctx(req),
              syncDeviceIdFromRequest(req),
              opIdFromRequest(req),
              await partyDeps(input.customerId, ctx(req)),
            );
          } catch (err) {
            logger.warn({ err, orderId: r.data.id }, "sync outbox enqueue failed after order create");
          }
        }
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

  // BUG-07 — informational check: which pending customer orders want the same
  // fabric/color the salesperson is about to sell? Read-only; never blocks.
  router.post(
    "/orders/pending-conflicts",
    auth,
    readGuard,
    validateBody(pendingConflictsSchema),
    async (req: Request, res: Response) => {
      const { lines } = body<{ lines: Array<{ fabricId?: string; colorId?: string; quantityKg: number }> }>(req);
      const r = await uc.findPendingConflictsUseCase(orderRepo, lines, ctx(req));
      if (r.ok) {
        res.json({ data: r.data });
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );

  router.get(
    "/orders/:id",
    auth,
    readGuard,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      const r = await uc.findOrderUseCase(orderRepo, pid(req), ctx(req));
      if (!r.ok) {
        return res.status(500).json({ code: "INTERNAL", message: r.error });
      }
      if (!r.data) {
        return res.status(404).json({ code: "NOT_FOUND", message: "الطلب غير موجود" });
      }
      res.json(r.data);
    },
  );

  router.post(
    "/orders/:id/cancel",
    auth,
    writeGuard,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      const r = await uc.cancelOrderUseCase(orderRepo, pid(req), ctx(req));
      if (r.ok) {
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          try {
            await enqueueOrderCancel(
              syncOutboxRepo,
              { id: r.data.id, code: r.data.code },
              ctx(req),
              syncDeviceIdFromRequest(req),
              opIdFromRequest(req),
            );
          } catch (err) {
            logger.warn({ err, orderId: r.data.id }, "sync outbox enqueue failed after order cancel");
          }
        }
        res.json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.post(
    "/orders/:id/fulfill",
    auth,
    writeGuard,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
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
    },
  );
}
