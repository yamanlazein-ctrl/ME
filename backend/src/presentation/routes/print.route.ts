import type { Router, Request, Response, RequestHandler } from "express";
import { validateBody } from "../../infrastructure/http/middleware/validate.middleware.js";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";
import type { IPrintJobRepository } from "../../application/ports/IPrintJobRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { createPrintJobSchema, receivePrintJobSchema } from "./print.schema.js";
import * as uc from "../../application/use-cases/printing/printJobUseCases.js";
import { nextDocumentNumber } from "../../infrastructure/utils/documentNumbers.js";

export function registerPrintRoutes(
  router: Router,
  printJobRepo: IPrintJobRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  router.post(
    "/printing/send",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(createPrintJobSchema),
    async (req: Request, res: Response) => {
      const r = await uc.createPrintJobUseCase(
        printJobRepo,
        body(req),
        await nextDocumentNumber("print", ctx(req).tenantId),
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
    "/printing/receive",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(receivePrintJobSchema),
    async (req: Request, res: Response) => {
      const r = await uc.receivePrintJobUseCase(printJobRepo, body(req), ctx(req));
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.get("/printing", auth, readGuard, async (req: Request, res: Response) => {
    const r = await uc.listPrintJobsUseCase(printJobRepo, ctx(req));
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(500).json({ code: "INTERNAL", message: r.error });
    }
  });

  router.get("/printing/open", auth, readGuard, async (req: Request, res: Response) => {
    const r = await uc.listOpenPrintJobsUseCase(printJobRepo, ctx(req));
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(500).json({ code: "INTERNAL", message: r.error });
    }
  });

  router.get("/printing/:id", auth, readGuard, validateUuidParam("id"), async (req: Request, res: Response) => {
    const r = await uc.findPrintJobUseCase(printJobRepo, req.params.id as string, ctx(req));
    if (!r.ok) {
      return res.status(500).json({ code: "INTERNAL", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "سند الطباعة غير موجود" });
    }
    res.json(r.data);
  });
}