import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";
import type { IExpenseRepository } from "../../application/ports/IExpenseRepository.js";
import type { IAuditRepository } from "../../application/ports/IAuditRepository.js";
import type { ISyncOutboxRepository } from "../../application/ports/ISyncOutboxRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import type { CreateExpenseInput } from "../../domain/entities/Expense.js";
import { createExpenseSchema, listExpensesSchema, addExpenseNameSchema } from "./expense.schema.js";
import * as uc from "../../application/use-cases/expenses/expenseUseCases.js";
import { nextDocumentNumber } from "../../infrastructure/utils/documentNumbers.js";
import {
  enqueueExpenseCancel,
  enqueueExpenseCreate,
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
import { logger } from "../../infrastructure/config/logger.js";

export function registerExpenseRoutes(
  router: Router,
  expenseRepo: IExpenseRepository,
  auditRepo: IAuditRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
  syncOutboxRepo?: ISyncOutboxRepository,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const pid = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  router.post(
    "/expenses",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(createExpenseSchema),
    async (req: Request, res: Response) => {
      const input = body<CreateExpenseInput>(req);
      const r = await uc.createExpenseUseCase(
        expenseRepo,
        auditRepo,
        input,
        await nextDocumentNumber("expense", ctx(req).tenantId),
        ctx(req),
      );
      if (r.ok) {
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          try {
            await enqueueExpenseCreate(
              syncOutboxRepo,
              { id: r.data.id, number: r.data.number },
              input,
              ctx(req),
              syncDeviceIdFromRequest(req),
              opIdFromRequest(req),
            );
          } catch (err) {
            logger.warn({ err, expenseId: r.data.id }, "sync outbox enqueue failed after expense create");
          }
        }
        res.status(201).json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.get(
    "/expenses",
    auth,
    readGuard,
    validateQuery(listExpensesSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listExpensesSchema>;
      const r = await uc.listExpensesUseCase(expenseRepo, filter, ctx(req));
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );

  // `/names` MUST be registered before `/expenses/:id` so it is not swallowed
  // by the `:id` parameter route (Express matches in registration order).
  router.get("/expenses/names", auth, readGuard, async (req: Request, res: Response) => {
    const r = await uc.listExpensesUseCase(expenseRepo, { limit: 1000 }, ctx(req));
    if (r.ok) {
      res.json(r.data.data.map((e) => e.category).filter((v, i, a) => a.indexOf(v) === i));
    } else {
      res.status(500).json({ code: "INTERNAL", message: r.error });
    }
  });

  // Expense names are derived from expense categories (see GET /expenses/names).
  // Accepting a new name here makes the flow non-breaking; the name becomes a
  // real suggestion once an expense is created with that category.
  router.post(
    "/expenses/names",
    auth,
    writeGuard,
    validateBody(addExpenseNameSchema),
    (_req: Request, res: Response) => {
      res.status(201).json({ ok: true });
    },
  );

  router.get(
    "/expenses/:id",
    auth,
    readGuard,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      const r = await uc.findExpenseUseCase(expenseRepo, pid(req), ctx(req));
      if (!r.ok) {
        return res.status(500).json({ code: "INTERNAL", message: r.error });
      }
      if (!r.data) {
        return res.status(404).json({ code: "NOT_FOUND", message: "المصروف غير موجود" });
      }
      res.json(r.data);
    },
  );

  router.post(
    "/expenses/:id/cancel",
    auth,
    writeGuard,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      const c = ctx(req);
      const r = await uc.cancelExpenseUseCase(expenseRepo, auditRepo, pid(req), c.userId, c);
      if (r.ok) {
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          try {
            await enqueueExpenseCancel(
              syncOutboxRepo,
              { id: r.data.id, number: r.data.number },
              c,
              syncDeviceIdFromRequest(req),
              opIdFromRequest(req),
            );
          } catch (err) {
            logger.warn({ err, expenseId: r.data.id }, "sync outbox enqueue failed after expense cancel");
          }
        }
        res.json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );
}
