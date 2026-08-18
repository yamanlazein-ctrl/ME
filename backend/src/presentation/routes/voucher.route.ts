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
import type { TenantContext } from "../../domain/types/index.js";
import { createVoucherSchema, listVouchersSchema } from "./voucher.schema.js";
import * as uc from "../../application/use-cases/vouchers/voucherUseCases.js";
import { nextDocumentNumber } from "../../infrastructure/utils/documentNumbers.js";

export function registerVoucherRoutes(
  router: Router,
  voucherRepo: IVoucherRepository,
  auditRepo: IAuditRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const pid = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  router.post(
    "/payments",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(createVoucherSchema),
    async (req: Request, res: Response) => {
      const b = body<Record<string, unknown>>(req);
      const r = await uc.createVoucherUseCase(
        voucherRepo,
        auditRepo,
        { ...b, kind: "payment" } as Parameters<typeof uc.createVoucherUseCase>[2],
        await nextDocumentNumber("voucher", ctx(req).tenantId),
        ctx(req),
      );
      if (r.ok) {
        res.status(201).json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.post(
    "/receipts",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(createVoucherSchema),
    async (req: Request, res: Response) => {
      const b = body<Record<string, unknown>>(req);
      const r = await uc.createVoucherUseCase(
        voucherRepo,
        auditRepo,
        { ...b, kind: "receipt" } as Parameters<typeof uc.createVoucherUseCase>[2],
        await nextDocumentNumber("voucher", ctx(req).tenantId),
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
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
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
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );

  router.get("/payments/:id", auth, readGuard, validateUuidParam("id"), async (req: Request, res: Response) => {
    const r = await uc.findVoucherUseCase(voucherRepo, pid(req), ctx(req));
    if (!r.ok) {
      return res.status(500).json({ code: "INTERNAL", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    res.json(r.data);
  });

  router.get("/receipts/:id", auth, readGuard, validateUuidParam("id"), async (req: Request, res: Response) => {
    const r = await uc.findVoucherUseCase(voucherRepo, pid(req), ctx(req));
    if (!r.ok) {
      return res.status(500).json({ code: "INTERNAL", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "السند غير موجود" });
    }
    res.json(r.data);
  });

  router.post("/payments/:id/cancel", auth, writeGuard, validateUuidParam("id"), async (req: Request, res: Response) => {
    const c = ctx(req);
    const r = await uc.cancelVoucherUseCase(voucherRepo, auditRepo, pid(req), c.userId, c);
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(422).json({ code: "VALIDATION", message: r.error });
    }
  });

  router.post("/receipts/:id/cancel", auth, writeGuard, validateUuidParam("id"), async (req: Request, res: Response) => {
    const c = ctx(req);
    const r = await uc.cancelVoucherUseCase(voucherRepo, auditRepo, pid(req), c.userId, c);
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(422).json({ code: "VALIDATION", message: r.error });
    }
  });
}
