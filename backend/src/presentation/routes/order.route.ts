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
import {
  createOrderSchema,
  updateOrderSchema,
  listOrdersSchema,
  pendingConflictsSchema,
} from "./order.schema.js";
import * as uc from "../../application/use-cases/orders/orderUseCases.js";
import {
  enqueueOrderCancel,
  enqueueOrderCreate,
  enqueueOrderUpdate,
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
import type { InvoiceSyncDependencies } from "../../application/use-cases/sync/syncDependencySnapshots.js";
import { capturePartySyncDependencies } from "../../application/use-cases/sync/syncDependencySnapshots.js";
import { logger } from "../../infrastructure/config/logger.js";
import { withTenantTx } from "../../infrastructure/orm/drizzle.js";

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
    // Canonical party capture (P1-step-2): the 25-field snapshot mapping lives
    // in exactly one place — toPartySnapshot — so route captures cannot drift.
    if (!partyRepo) return null;
    return capturePartySyncDependencies(partyRepo, [partyId], tenantCtx);
  }

  router.post(
    "/orders",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(createOrderSchema),
    async (req: Request, res: Response) => {
      const input = body<CreateOrderInput>(req);
      const c = ctx(req);
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());

      // F-07: the order and its outbox unit share ONE transaction.
      // P4: the code is minted INSIDE the repository transaction from the
      // device's reserved block (never pre-minted from the shared sequence),
      // so a rollback burns nothing and offline devices cannot collide.
      const runCreate = async () => {
        const created = await uc.createOrderUseCase(orderRepo, input, undefined, c);
        if (!created.ok) return created;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueOrderCreate(
            syncOutboxRepo,
            { id: created.data.id, code: created.data.code },
            input,
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
            await partyDeps(input.customerId, c),
          );
        }
        return created;
      };

      let r: Awaited<ReturnType<typeof uc.createOrderUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runCreate) : await runCreate();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — order create dropped (F-07)");
        return res.status(500).json({
          code: "SYNC_OUTBOX_FAILED",
          message: "تعذّر حفظ الطلبية مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
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

  // SYNC-13: order edits enqueue update units in the same transaction
  // (F-07 pattern); the pre-edit version is the stale-base guard.
  router.put(
    "/orders/:id",
    auth,
    writeGuard,
    validateUuidParam("id"),
    validateBody(updateOrderSchema),
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
        const before = await orderRepo.findById(id, c);
        const r = await uc.updateOrderUseCase(orderRepo, id, input, c, expectedVersion);
        if (!r.ok) return r;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueOrderUpdate(
            syncOutboxRepo,
            { id: r.data.id, code: r.data.code },
            input,
            null,
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
            {
              version: (before as unknown as { version?: number } | null)?.version ?? null,
            },
          );
        }
        return r;
      };
      let r: Awaited<ReturnType<typeof uc.updateOrderUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runUpdate) : await runUpdate();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — order update dropped (F-07)");
        return res.status(500).json({ code: "INTERNAL", message: "فشل تحديث الطلب" });
      }
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
      const { lines } = body<{
        lines: Array<{ fabricId?: string; colorId?: string; quantityKg: number }>;
      }>(req);
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
      const c = ctx(req);
      const expectedVersion = req.body?.expectedVersion;
      if (typeof expectedVersion !== "number") {
        return res.status(400).json({ code: "EXPECTED_VERSION_REQUIRED", message: "الإصدار المتوقع (expectedVersion) مطلوب للتحديث/الإلغاء" });
      }
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());

      // F-07: the order cancel and its outbox unit share ONE transaction.
      const runCancel = async () => {
        const cancelled = await uc.cancelOrderUseCase(orderRepo, pid(req), c, expectedVersion);
        if (!cancelled.ok) return cancelled;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueOrderCancel(
            syncOutboxRepo,
            { id: cancelled.data.id, code: cancelled.data.code },
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
            // Version this cancel was validated against locally — the hub
            // refuses a stale-base cancel instead of voiding a newer edit.
            expectedVersion,
          );
        }
        return cancelled;
      };

      let r: Awaited<ReturnType<typeof uc.cancelOrderUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runCancel) : await runCancel();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — order cancel dropped (F-07)");
        return res.status(500).json({
          code: "SYNC_OUTBOX_FAILED",
          message: "تعذّر حفظ إلغاء الطلبية مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
          statusCode: 500,
        });
      }

      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  // SYNC-13: fulfillment is an order update for sync purposes (same identity
  // claim, same stale-base guard) with the fulfilling invoice attached.
  router.post(
    "/orders/:id/fulfill",
    auth,
    writeGuard,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      const c = ctx(req);
      const id = pid(req);
      const invoiceId = (req.body as { invoiceId?: string }).invoiceId;
      if (!invoiceId) {
        return res.status(400).json({ code: "VALIDATION", message: "invoiceId مطلوب" });
      }
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());
      const runFulfill = async () => {
        const before = await orderRepo.findById(id, c);
        const r = await uc.fulfillOrderUseCase(orderRepo, id, invoiceId, c);
        if (!r.ok) return r;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueOrderUpdate(
            syncOutboxRepo,
            { id: r.data.id, code: r.data.code },
            {},
            invoiceId,
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
            {
              version: (before as unknown as { version?: number } | null)?.version ?? null,
            },
          );
        }
        return r;
      };
      let r: Awaited<ReturnType<typeof uc.fulfillOrderUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runFulfill) : await runFulfill();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — order fulfill dropped (F-07)");
        return res.status(500).json({ code: "INTERNAL", message: "فشل تنفيذ الطلب" });
      }
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );
}
