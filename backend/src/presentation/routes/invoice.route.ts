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

export function registerInvoiceRoutes(
  router: Router,
  invoiceRepo: IInvoiceRepository,
  auditRepo: IAuditRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
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
      const number = await peekNextDocumentNumber(entityType, ctx(req).tenantId);
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
      const r = await uc.updateInvoiceUseCase(
        invoiceRepo,
        auditRepo,
        pid(req),
        body(req),
        c,
      );
      if (r.ok) {
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
        res.json(r.data);
      } else if ((r as { code?: string }).code === "NOT_FOUND") {
        res.status(404).json({ code: "NOT_FOUND", message: r.error });
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );
}
