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
import {
  enqueueExpenseCancel,
  enqueueExpenseCreate,
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
import { logger } from "../../infrastructure/config/logger.js";
import { withTenantTx } from "../../infrastructure/orm/drizzle.js";

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
    idempotency("POST", { required: true }),
    validateBody(createExpenseSchema),
    async (req: Request, res: Response) => {
      const input = body<CreateExpenseInput>(req);
      const c = ctx(req);
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());

      // F-07: the expense and its outbox unit share ONE transaction.
      // P4: the number is minted INSIDE the repository transaction from the
      // device's reserved block (never pre-minted from the shared sequence),
      // so a rollback burns nothing and offline devices cannot collide.
      const runCreate = async () => {
        const created = await uc.createExpenseUseCase(expenseRepo, auditRepo, input, undefined, c);
        if (!created.ok) return created;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueExpenseCreate(
            syncOutboxRepo,
            { id: created.data.id, number: created.data.number },
            input,
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
          );
        }
        return created;
      };

      let r: Awaited<ReturnType<typeof uc.createExpenseUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runCreate) : await runCreate();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — expense create dropped (F-07)");
        return res.status(500).json({
          code: "SYNC_OUTBOX_FAILED",
          message: "تعذّر حفظ المصروف مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
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
    // REPAIR-001: page through until exhausted — never treat one 1,000-row page as "all".
    const names = new Set<string>();
    const c = ctx(req);
    for (let page = 0; page < 50; page++) {
      const r = await uc.listExpensesUseCase(expenseRepo, { limit: 200, page }, c);
      if (!r.ok) {
        res.status(500).json({ code: "INTERNAL", message: r.error });
        return;
      }
      for (const e of r.data.data) names.add(e.category);
      if (!r.data.meta?.hasNext || r.data.data.length === 0) break;
    }
    res.json([...names]);
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
      const expectedVersion = req.body?.expectedVersion;
      if (typeof expectedVersion !== "number") {
        return res.status(400).json({ code: "EXPECTED_VERSION_REQUIRED", message: "الإصدار المتوقع (expectedVersion) مطلوب للتحديث/الإلغاء" });
      }
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());

      // F-07: the expense cancel and its outbox unit share ONE transaction.
      const runCancel = async () => {
        const cancelled = await uc.cancelExpenseUseCase(
          expenseRepo,
          auditRepo,
          pid(req),
          c.userId,
          c,
          expectedVersion,
        );
        if (!cancelled.ok) return cancelled;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueExpenseCancel(
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

      let r: Awaited<ReturnType<typeof uc.cancelExpenseUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runCancel) : await runCancel();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — expense cancel dropped (F-07)");
        return res.status(500).json({
          code: "SYNC_OUTBOX_FAILED",
          message: "تعذّر حفظ إلغاء المصروف مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
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
}
