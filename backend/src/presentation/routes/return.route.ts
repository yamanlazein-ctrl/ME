import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";
import type { IReturnRepository } from "../../application/ports/IReturnRepository.js";
import type { IAuditRepository } from "../../application/ports/IAuditRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { createReturnSchema, listReturnsSchema } from "./return.schema.js";
import * as uc from "../../application/use-cases/returns/returnUseCases.js";
import { nextDocumentNumber } from "../../infrastructure/utils/documentNumbers.js";

export function registerReturnRoutes(
  router: Router,
  returnRepo: IReturnRepository,
  auditRepo: IAuditRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const pid = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  router.post(
    "/returns",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(createReturnSchema),
    async (req: Request, res: Response) => {
      const r = await uc.createReturnUseCase(
        returnRepo,
        auditRepo,
        body(req),
        await nextDocumentNumber("return", ctx(req).tenantId),
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
    "/returns",
    auth,
    readGuard,
    validateQuery(listReturnsSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listReturnsSchema>;
      const r = await uc.listReturnsUseCase(returnRepo, filter, ctx(req));
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );

  router.get("/returns/:id", auth, readGuard, validateUuidParam("id"), async (req: Request, res: Response) => {
    const r = await uc.findReturnUseCase(returnRepo, pid(req), ctx(req));
    if (!r.ok) {
      return res.status(500).json({ code: "INTERNAL", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "المرتجع غير موجود" });
    }
    res.json(r.data);
  });

  router.post("/returns/:id/cancel", auth, writeGuard, validateUuidParam("id"), async (req: Request, res: Response) => {
    const c = ctx(req);
    const r = await uc.cancelReturnUseCase(returnRepo, auditRepo, pid(req), c.userId, c);
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(422).json({ code: "VALIDATION", message: r.error });
    }
  });
}
