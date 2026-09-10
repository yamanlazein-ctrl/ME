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
import { config } from "../../infrastructure/config/env.js";
import { logger } from "../../infrastructure/config/logger.js";

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
    idempotency("POST"),
    validateBody(createInvoiceSchema),
    async (req: Request, res: Response) => {
      const input = body<CreateInvoiceInput>(req);
      // H-NEW: number allocation moved INSIDE the repository transaction
      // (PostgresInvoiceRepository.create → allocateDocumentNumber), so a
      // failed save no longer burns a number. The route no longer needs to
      // pre-call nextDocumentNumber here.
      const r = await uc.createInvoiceUseCase(
        invoiceRepo,
        auditRepo,
        input,
        ctx(req),
      );
      if (r.ok) {
        if (syncOutboxRepo && (config.DESKTOP_DEPLOY || config.CENTRAL_SYNC_URL)) {
          const deviceHeader = req.headers["x-sync-device-id"];
          const syncDeviceId =
            typeof deviceHeader === "string" ? deviceHeader : Array.isArray(deviceHeader) ? deviceHeader[0] : null;
          const opHeader = req.headers["idempotency-key"];
          const opId =
            typeof opHeader === "string" ? opHeader : Array.isArray(opHeader) ? opHeader[0] : undefined;
          try {
            const dependencies = dependencyRepos
              ? await captureInvoiceSyncDependencies(dependencyRepos, input, ctx(req))
              : null;
            await enqueueInvoiceCreate(
              syncOutboxRepo,
              {
                id: r.data.id,
                type: r.data.type,
                number: r.data.number,
                partyId: r.data.partyId,
                lines: r.data.lines.map((l) => ({
                  rollId: l.rollId,
                  quantityKg: l.quantityKg,
                })),
              },
              input,
              ctx(req),
              syncDeviceId ?? null,
              opId,
              dependencies,
            );
          } catch (err) {
            logger.warn({ err, invoiceId: r.data.id }, "sync outbox enqueue failed after invoice create");
          }
        }
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
    if (type !== "sale" && type !== "entry") {
      return res.status(400).json({ code: "BAD_REQUEST", message: "type يجب أن يكون sale أو entry" });
    }
    const entityType = type === "entry" ? "invoice_entry" : "invoice";
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
    idempotency("PUT"),
    validateUuidParam("id"),
    validateBody(updateInvoiceSchema),
    async (req: Request, res: Response) => {
      const c = ctx(req);
      const updateInput = body<Parameters<typeof uc.updateInvoiceUseCase>[3]>(req);
      const r = await uc.updateInvoiceUseCase(
        invoiceRepo,
        auditRepo,
        pid(req),
        updateInput,
        c,
      );
      if (r.ok) {
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          try {
            const dependencies = dependencyRepos
              ? await captureInvoiceSyncDependencies(
                  dependencyRepos,
                  {
                    type: r.data.type,
                    partyId: r.data.partyId,
                    partyType: r.data.partyType,
                    date: updateInput.date,
                    currency: r.data.currency,
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
              { id: r.data.id, number: r.data.number, type: r.data.type },
              updateInput,
              c,
              syncDeviceIdFromRequest(req),
              opIdFromRequest(req),
              dependencies,
            );
          } catch (err) {
            logger.warn({ err, invoiceId: r.data.id }, "sync outbox enqueue failed after invoice update");
          }
        }
        res.json(r.data);
      } else if ((r as { code?: string }).code === "NOT_FOUND") {
        res.status(404).json({ code: "NOT_FOUND", message: r.error });
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
      const r = await uc.cancelInvoiceUseCase(invoiceRepo, auditRepo, pid(req), c.userId, c);
      if (r.ok) {
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          try {
            await enqueueInvoiceCancel(
              syncOutboxRepo,
              { id: r.data.id, number: r.data.number, type: r.data.type },
              c,
              syncDeviceIdFromRequest(req),
              opIdFromRequest(req),
            );
          } catch (err) {
            logger.warn({ err, invoiceId: r.data.id }, "sync outbox enqueue failed after invoice cancel");
          }
        }
        res.json(r.data);
      } else if ((r as { code?: string }).code === "NOT_FOUND") {
        res.status(404).json({ code: "NOT_FOUND", message: r.error });
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );
}
