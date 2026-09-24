import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";
import type { IInvoiceRepository } from "../../application/ports/IInvoiceRepository.js";
import type { IAuditRepository } from "../../application/ports/IAuditRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import {
  createInvoiceSchema,
  updateInvoiceSchema,
  listInvoicesSchema,
  type CreateInvoiceInput,
} from "./invoice.schema.js";
import * as uc from "../../application/use-cases/invoices/invoiceUseCases.js";
import { peekNextDocumentNumber } from "../../infrastructure/utils/documentNumbers.js";
import { enqueueInvoiceCreate } from "../../application/use-cases/sync/syncUseCases.js";
import { captureInvoiceSyncDependencies } from "../../application/use-cases/sync/syncDependencySnapshots.js";
import {
  enqueueInvoiceCancel,
  enqueueInvoiceUpdate,
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
import type { ISyncOutboxRepository } from "../../application/ports/ISyncOutboxRepository.js";
import type { IPartyRepository } from "../../application/ports/IPartyRepository.js";
import type { IFabricRepository } from "../../application/ports/IFabricRepository.js";
import type { IColorRepository } from "../../application/ports/IColorRepository.js";
import type { IRollRepository } from "../../application/ports/IRollRepository.js";
import { logger } from "../../infrastructure/config/logger.js";
import { withTenantTx } from "../../infrastructure/orm/drizzle.js";
import { respondTransactionFailure } from "../../infrastructure/http/transactionRouteError.js";

export function registerInvoiceRoutes(
  router: Router,
  invoiceRepo: IInvoiceRepository,
  auditRepo: IAuditRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
  syncOutboxRepo?: ISyncOutboxRepository,
  dependencyRepos?: {
    partyRepo: IPartyRepository;
    fabricRepo: IFabricRepository;
    colorRepo: IColorRepository;
    rollRepo: IRollRepository;
  },
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const pid = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  router.post(
    "/invoices",
    auth,
    writeGuard,
    idempotency("POST", { required: true }),
    validateBody(createInvoiceSchema),
    async (req: Request, res: Response) => {
      const input = body<CreateInvoiceInput>(req);
      const c = ctx(req);
      // H-NEW: number allocation moved INSIDE the repository transaction
      // (PostgresInvoiceRepository.create → allocateDocumentNumber), so a
      // failed save no longer burns a number. The route no longer needs to
      // pre-call nextDocumentNumber here.
      const deviceHeader = req.headers["x-sync-device-id"];
      const syncDeviceId =
        typeof deviceHeader === "string"
          ? deviceHeader
          : Array.isArray(deviceHeader)
            ? deviceHeader[0]
            : null;
      const opHeader = req.headers["idempotency-key"];
      const opId =
        typeof opHeader === "string" ? opHeader : Array.isArray(opHeader) ? opHeader[0] : undefined;
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());

      // F-07 (Transactional Outbox): the business write and its outbox unit are
      // produced inside ONE `withTenantTx`. `withTenantTx` publishes that
      // transaction as the ambient tx, so `invoiceRepo`/`syncOutboxRepo`
      // (built with `ambientDb`) join it as a savepoint rather than opening a
      // second pooled connection. Either both commit or both roll back — a
      // document can never be durably saved locally without its sync unit, and
      // a failed enqueue no longer disappears into a swallowed warn.
      // When sync is disabled the code path stays exactly as it was before
      // (no extra transaction is opened) — F-07 only binds the two writes that
      // must be atomic.
      const runCreate = async () => {
        const created = await uc.createInvoiceUseCase(invoiceRepo, auditRepo, input, c);
        if (!created.ok) return created;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          const dependencies = dependencyRepos
            ? await captureInvoiceSyncDependencies(dependencyRepos, input, c)
            : null;
          await enqueueInvoiceCreate(
            syncOutboxRepo,
            {
              id: created.data.id,
              type: created.data.type,
              number: created.data.number,
              partyId: created.data.partyId,
              linkedVoucherId: created.data.linkedVoucherId ?? null,
              lines: created.data.lines.map((l) => ({
                rollId: l.rollId,
                quantityKg: l.quantityKg,
                pieces: l.pieces ?? 0,
                costPerKg: l.costPerKg ?? null,
              })),
            },
            input,
            c,
            syncDeviceId ?? null,
            opId,
            dependencies,
          );
        }
        return created;
      };

      // F-07 (Transactional Outbox): the business write and its outbox unit are
      // produced inside ONE `withTenantTx`. `withTenantTx` publishes that
      // transaction as the ambient tx, so `invoiceRepo`/`syncOutboxRepo`
      // (built with `ambientDb`) join it as a savepoint rather than opening a
      // second pooled connection. Either both commit or both roll back — a
      // document can never be durably saved locally without its sync unit, and
      // a failed enqueue no longer disappears into a swallowed warn.
      let r: Awaited<ReturnType<typeof uc.createInvoiceUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runCreate) : await runCreate();
      } catch (err) {
        logger.error(
          { err, opId },
          "transaction rolled back — business write dropped with its sync unit (F-07)",
        );
        return respondTransactionFailure(
          res,
          err,
          "invoice",
          "تعذّر حفظ الفاتورة مع وحدة المزامنة — لم يُحفظ أي تغيير",
        );
      }

      if (r.ok) {
        res.status(201).json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.get(
    "/invoices",
    auth,
    readGuard,
    validateQuery(listInvoicesSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listInvoicesSchema>;
      const r = await uc.listInvoicesUseCase(invoiceRepo, filter, ctx(req));
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );

  // #7: read-only next-number preview for the new-invoice screens. MUST be
  // registered before "/invoices/:id" so "next-number" isn't captured as an id.
  router.get("/invoices/next-number", auth, readGuard, async (req: Request, res: Response) => {
    const type = String((req.query.type as string) ?? "sale");
    if (type !== "sale" && type !== "entry" && type !== "print") {
      return res
        .status(400)
        .json({ code: "BAD_REQUEST", message: "type يجب أن يكون sale أو entry أو print" });
    }
    const entityType = type === "entry" ? "invoice_entry" : type === "print" ? "print" : "invoice";
    try {
      const number = await peekNextDocumentNumber(
        entityType,
        ctx(req).tenantId,
        ctx(req).syncDeviceId,
      );
      return res.json({ number, estimate: true });
    } catch (e) {
      return res.status(500).json({
        code: "INTERNAL",
        message: e instanceof Error ? e.message : "تعذر قراءة الرقم التالي",
      });
    }
  });

  router.get("/invoices/number/:number", auth, readGuard, async (req: Request, res: Response) => {
    const r = await uc.findInvoiceByNumberUseCase(
      invoiceRepo,
      req.params.number as string,
      (req.query.type as string) ?? "sale",
      ctx(req),
    );
    if (!r.ok) {
      return res.status(500).json({ code: "INTERNAL", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
    }
    res.json(r.data);
  });

  router.get(
    "/invoices/:id",
    auth,
    readGuard,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      const r = await uc.findInvoiceUseCase(invoiceRepo, pid(req), ctx(req));
      if (!r.ok) {
        return res.status(500).json({ code: "INTERNAL", message: r.error });
      }
      if (!r.data) {
        return res.status(404).json({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
      }
      res.json(r.data);
    },
  );

  router.put(
    "/invoices/:id",
    auth,
    writeGuard,
    idempotency("PUT", { required: true }),
    validateUuidParam("id"),
    validateBody(updateInvoiceSchema),
    async (req: Request, res: Response) => {
      const c = ctx(req);
      const updateInput = body<Parameters<typeof uc.updateInvoiceUseCase>[3]>(req);
      const expectedVersion = req.body?.expectedVersion;
      if (typeof expectedVersion !== "number") {
        return res.status(400).json({ code: "EXPECTED_VERSION_REQUIRED", message: "الإصدار المتوقع (expectedVersion) مطلوب للتحديث/الإلغاء" });
      }
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());

      // F-07: the update and its outbox unit share ONE transaction.
      const runUpdate = async () => {
        // P3b: stamp the pre-edit version into the sync unit in the SAME
        // transaction, so the hub can refuse a stale edit instead of silently
        // overwriting a newer one. A missing row here cannot happen (the
        // update below would 404) — NULL keeps the unit accepted, unchecked.
        const before = await invoiceRepo.findById(pid(req), c);
        const updated = await uc.updateInvoiceUseCase(
          invoiceRepo,
          auditRepo,
          pid(req),
          updateInput,
          c,
          expectedVersion,
        );
        if (!updated.ok) return updated;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          const dependencies = dependencyRepos
            ? await captureInvoiceSyncDependencies(
                dependencyRepos,
                {
                  type: updated.data.type,
                  partyId: updated.data.partyId,
                  partyType: updated.data.partyType,
                  date: updateInput.date,
                  currency: updated.data.currency,
                  lines: updateInput.lines,
                  discount: updateInput.discount,
                  tax: updateInput.tax,
                  shipping: updateInput.shipping,
                  notes: updateInput.notes,
                },
                c,
              )
            : null;
          await enqueueInvoiceUpdate(
            syncOutboxRepo,
            { id: updated.data.id, number: updated.data.number, type: updated.data.type },
            updateInput,
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
            dependencies,
            before?.version ?? null,
          );
        }
        return updated;
      };

      let r: Awaited<ReturnType<typeof uc.updateInvoiceUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runUpdate) : await runUpdate();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — invoice update dropped (F-07)");
        return respondTransactionFailure(
          res,
          err,
          "invoice",
          "تعذّر حفظ تعديل الفاتورة مع وحدة المزامنة — لم يُحفظ أي تغيير",
        );
      }

      if (r.ok) {
        res.json(r.data);
      } else if ((r as { code?: string }).code === "NOT_FOUND") {
        res.status(404).json({ code: "NOT_FOUND", message: r.error });
      } else if ((r as { code?: string }).code === "STALE_VERSION") {
        res.status(409).json({ code: "STALE_VERSION", message: r.error });
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.post(
    "/invoices/:id/cancel",
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

      // F-07: the cancel and its outbox unit share ONE transaction.
      const runCancel = async () => {
        const cancelled = await uc.cancelInvoiceUseCase(
          invoiceRepo,
          auditRepo,
          pid(req),
          c.userId,
          c,
          expectedVersion,
        );
        if (!cancelled.ok) return cancelled;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueInvoiceCancel(
            syncOutboxRepo,
            { id: cancelled.data.id, number: cancelled.data.number, type: cancelled.data.type },
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
            // The version this cancel was validated against locally. The hub
            // refuses a cancel whose base is stale (another device edited the
            // invoice) instead of silently voiding that newer edit.
            expectedVersion,
          );
        }
        return cancelled;
      };

      let r: Awaited<ReturnType<typeof uc.cancelInvoiceUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runCancel) : await runCancel();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — invoice cancel dropped (F-07)");
        return respondTransactionFailure(
          res,
          err,
          "invoice",
          "تعذّر إلغاء الفاتورة مع وحدة المزامنة — لم يُحفظ أي تغيير",
        );
      }

      if (r.ok) {
        res.json(r.data);
      } else if ((r as { code?: string }).code === "NOT_FOUND") {
        res.status(404).json({ code: "NOT_FOUND", message: r.error });
      } else if ((r as { code?: string }).code === "STALE_VERSION") {
        res.status(409).json({ code: "STALE_VERSION", message: r.error });
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );
}
