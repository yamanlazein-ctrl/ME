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
  enqueueVoucherCreate,
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
import type { InvoiceSyncDependencies } from "../../application/use-cases/sync/syncDependencySnapshots.js";
import { logger } from "../../infrastructure/config/logger.js";

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
    if (!partyRepo) return null;
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

  async function createAndEnqueue(
    req: Request,
    res: Response,
    kind: "payment" | "receipt",
  ) {
    const b = body<Record<string, unknown>>(req);
    const input = { ...b, kind } as CreateVoucherInput;
    const r = await uc.createVoucherUseCase(voucherRepo, auditRepo, input, ctx(req));
    if (!r.ok) {
      res.status(422).json({ code: "VALIDATION", message: r.error });
      return;
    }
    if (syncOutboxRepo && isSyncEnqueueEnabled()) {
      try {
        await enqueueVoucherCreate(
          syncOutboxRepo,
          {
            id: r.data.id,
            kind: r.data.kind,
            number: r.data.number,
            partyId: r.data.partyId,
          },
          input,
          ctx(req),
          syncDeviceIdFromRequest(req),
          opIdFromRequest(req),
          await partyDeps(r.data.partyId, ctx(req)),
        );
      } catch (err) {
        logger.warn({ err, voucherId: r.data.id }, "sync outbox enqueue failed after voucher create");
      }
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
      const r = await uc.cancelVoucherUseCase(voucherRepo, auditRepo, pid(req), c.userId, c);
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
      const r = await uc.cancelVoucherUseCase(voucherRepo, auditRepo, pid(req), c.userId, c);
      if (r.ok) res.json(r.data);
      else res.status(422).json({ code: "VALIDATION", message: r.error });
    },
  );
}
