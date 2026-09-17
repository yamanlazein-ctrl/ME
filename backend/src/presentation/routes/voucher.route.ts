import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";
import type { IVoucherRepository } from "../../application/ports/IVoucherRepository.js";
import type { IAuditRepository } from "../../application/ports/IAuditRepository.js";
import type { ISyncOutboxRepository } from "../../application/ports/ISyncOutboxRepository.js";
import type { IPartyRepository } from "../../application/ports/IPartyRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import type { CreateVoucherInput } from "../../domain/entities/Voucher.js";
import { createVoucherSchema, listVouchersSchema } from "./voucher.schema.js";
import * as uc from "../../application/use-cases/vouchers/voucherUseCases.js";
import {
  enqueueVoucherCancel,
  enqueueVoucherCreate,
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
import type { InvoiceSyncDependencies } from "../../application/use-cases/sync/syncDependencySnapshots.js";
import { capturePartySyncDependencies } from "../../application/use-cases/sync/syncDependencySnapshots.js";
import { logger } from "../../infrastructure/config/logger.js";
import { withTenantTx } from "../../infrastructure/orm/drizzle.js";
import { respondTransactionFailure } from "../../infrastructure/http/transactionRouteError.js";

export function registerVoucherRoutes(
  router: Router,
  voucherRepo: IVoucherRepository,
  auditRepo: IAuditRepository,
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
    partyId: string,
    tenantCtx: TenantContext,
  ): Promise<InvoiceSyncDependencies | null> {
    // Canonical party capture (P1-step-2): the 25-field snapshot mapping lives
    // in exactly one place — toPartySnapshot — so route captures cannot drift.
    if (!partyRepo) return null;
    return capturePartySyncDependencies(partyRepo, [partyId], tenantCtx);
  }

  async function createAndEnqueue(req: Request, res: Response, kind: "payment" | "receipt") {
    const b = body<Record<string, unknown>>(req);
    const input = { ...b, kind } as CreateVoucherInput;
    const c = ctx(req);
    const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());

    // F-07: the voucher and its outbox unit share ONE transaction.
    const runCreate = async () => {
      const created = await uc.createVoucherUseCase(voucherRepo, auditRepo, input, c);
      if (!created.ok) return created;
      if (syncOutboxRepo && isSyncEnqueueEnabled()) {
        await enqueueVoucherCreate(
          syncOutboxRepo,
          {
            id: created.data.id,
            kind: created.data.kind,
            number: created.data.number,
            partyId: created.data.partyId,
          },
          input,
          c,
          syncDeviceIdFromRequest(req),
          opIdFromRequest(req),
          await partyDeps(created.data.partyId, c),
        );
      }
      return created;
    };

    let r: Awaited<ReturnType<typeof uc.createVoucherUseCase>>;
    try {
      r = syncEnabled ? await withTenantTx(c.tenantId, runCreate) : await runCreate();
    } catch (err) {
      logger.error({ err }, "transaction rolled back — voucher create dropped (F-07)");
      respondTransactionFailure(
        res,
        err,
        "voucher",
        "تعذّر حفظ السند مع وحدة المزامنة — لم يُحفظ أي تغيير",
      );
      return;
    }
    if (!r.ok) {
      res.status(422).json({ code: "VALIDATION", message: r.error });
      return;
    }
    res.status(201).json(r.data);
  }

  router.post(
    "/payments",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(createVoucherSchema),
    async (req: Request, res: Response) => createAndEnqueue(req, res, "payment"),
  );

  router.post(
    "/receipts",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(createVoucherSchema),
    async (req: Request, res: Response) => createAndEnqueue(req, res, "receipt"),
  );

  router.get(
    "/payments",
    auth,
    readGuard,
    validateQuery(listVouchersSchema),
    async (req: Request, res: Response) => {
      const filter = {
        ...(req.validatedQuery as z.infer<typeof listVouchersSchema>),
        kind: "payment" as const,
      };
      const r = await uc.listVouchersUseCase(voucherRepo, filter, ctx(req));
      if (r.ok) res.json(r.data);
      else res.status(500).json({ code: "INTERNAL", message: r.error });
    },
  );

  router.get(
    "/receipts",
    auth,
    readGuard,
    validateQuery(listVouchersSchema),
    async (req: Request, res: Response) => {
      const filter = {
        ...(req.validatedQuery as z.infer<typeof listVouchersSchema>),
        kind: "receipt" as const,
      };
      const r = await uc.listVouchersUseCase(voucherRepo, filter, ctx(req));
      if (r.ok) res.json(r.data);
      else res.status(500).json({ code: "INTERNAL", message: r.error });
    },
  );

  router.get("/vouchers/:id", auth, readGuard, validateUuidParam("id"), async (req, res) => {
    const r = await uc.findVoucherUseCase(voucherRepo, pid(req), ctx(req));
    if (!r.ok) return res.status(500).json({ code: "INTERNAL", message: r.error });
    if (!r.data) return res.status(404).json({ code: "NOT_FOUND", message: "غير موجود" });
    res.json(r.data);
  });

  router.get("/payments/:id", auth, readGuard, validateUuidParam("id"), async (req, res) => {
    const r = await uc.findVoucherUseCase(voucherRepo, pid(req), ctx(req));
    if (!r.ok) return res.status(500).json({ code: "INTERNAL", message: r.error });
    if (!r.data) return res.status(404).json({ code: "NOT_FOUND", message: "غير موجود" });
    res.json(r.data);
  });

  router.get("/receipts/:id", auth, readGuard, validateUuidParam("id"), async (req, res) => {
    const r = await uc.findVoucherUseCase(voucherRepo, pid(req), ctx(req));
    if (!r.ok) return res.status(500).json({ code: "INTERNAL", message: r.error });
    if (!r.data) return res.status(404).json({ code: "NOT_FOUND", message: "غير موجود" });
    res.json(r.data);
  });

  router.post(
    "/payments/:id/cancel",
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

      // F-07 + P5: the cancel and its outbox unit share ONE transaction, so a
      // voucher cancelled on this device converges on the hub and all peers
      // instead of diverging from them permanently.
      const runCancel = async () => {
        const cancelled = await uc.cancelVoucherUseCase(
          voucherRepo,
          auditRepo,
          pid(req),
          c.userId,
          c,
          expectedVersion,
        );
        if (!cancelled.ok) return cancelled;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueVoucherCancel(
            syncOutboxRepo,
            { id: cancelled.data.id, number: cancelled.data.number },
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

      let r: Awaited<ReturnType<typeof uc.cancelVoucherUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runCancel) : await runCancel();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — voucher cancel dropped (F-07)");
        return respondTransactionFailure(
          res,
          err,
          "voucher",
          "تعذّر إلغاء السند مع وحدة المزامنة — لم يُحفظ أي تغيير",
        );
      }
      if (r.ok) res.json(r.data);
      else res.status(422).json({ code: "VALIDATION", message: r.error });
    },
  );

  router.post(
    "/receipts/:id/cancel",
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

      // Same transactional cancel+enqueue as /payments/:id/cancel above.
      const runCancel = async () => {
        const cancelled = await uc.cancelVoucherUseCase(
          voucherRepo,
          auditRepo,
          pid(req),
          c.userId,
          c,
          expectedVersion,
        );
        if (!cancelled.ok) return cancelled;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueVoucherCancel(
            syncOutboxRepo,
            { id: cancelled.data.id, number: cancelled.data.number },
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

      let r: Awaited<ReturnType<typeof uc.cancelVoucherUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runCancel) : await runCancel();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — voucher cancel dropped (F-07)");
        return respondTransactionFailure(
          res,
          err,
          "voucher",
          "تعذّر إلغاء السند مع وحدة المزامنة — لم يُحفظ أي تغيير",
        );
      }
      if (r.ok) res.json(r.data);
      else res.status(422).json({ code: "VALIDATION", message: r.error });
    },
  );
}
