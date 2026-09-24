import type { Router, Request, Response, RequestHandler } from "express";
import { validateBody } from "../../infrastructure/http/middleware/validate.middleware.js";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";
import type { IPrintJobRepository } from "../../application/ports/IPrintJobRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { createPrintJobSchema, receivePrintJobSchema } from "./print.schema.js";
import * as uc from "../../application/use-cases/printing/printJobUseCases.js";
import type { ISyncOutboxRepository } from "../../application/ports/ISyncOutboxRepository.js";
import {
  enqueuePrintReceive,
  enqueuePrintSend,
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
import { withTenantTx } from "../../infrastructure/orm/drizzle.js";
import { rolls } from "../../infrastructure/orm/schemas/roll.table.js";
import { eq } from "drizzle-orm";
import { logger } from "../../infrastructure/config/logger.js";

export function registerPrintRoutes(
  router: Router,
  printJobRepo: IPrintJobRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
  syncOutboxRepo?: ISyncOutboxRepository,
) {
  // F-07: the press operation and its sync unit commit together or not at all.
  const syncOn = () => Boolean(syncOutboxRepo && isSyncEnqueueEnabled());
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  router.post(
    "/printing/send",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(createPrintJobSchema),
    async (req: Request, res: Response) => {
      const c = ctx(req);
      let r: Awaited<ReturnType<typeof uc.createPrintJobUseCase>>;
      try {
        const runSend = async () => {
          const created = await uc.createPrintJobUseCase(
            printJobRepo,
            body(req),
            // null → allocated inside the save transaction, so a rejected send
            // (stock guard, validation) never burns a PRT number.
            null,
            c,
          );
          if (created.ok && syncOn()) {
            await enqueuePrintSend(
              syncOutboxRepo!,
              { id: created.data.id, number: created.data.number },
              body<Record<string, unknown>>(req),
              c,
              syncDeviceIdFromRequest(req),
              opIdFromRequest(req),
            );
          }
          return created;
        };
        r = syncOn() ? await withTenantTx(c.tenantId, runSend) : await runSend();
      } catch (err) {
        logger.error({ err }, "print send rolled back (sync unit could not be written)");
        res.status(500).json({
          code: "SYNC_OUTBOX_FAILED",
          message: "تعذّر حفظ أمر الطباعة مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
        });
        return;
      }
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
      const c = ctx(req);
      let r: Awaited<ReturnType<typeof uc.receivePrintJobUseCase>>;
      try {
        const runReceive = async () => {
          const received = await uc.receivePrintJobUseCase(printJobRepo, body(req), c);
          if (received.ok && syncOn()) {
            let resultRollNo: string | undefined;
            if (received.data.resultRollId) {
              // Read INSIDE the ambient transaction: the roll is not committed yet.
              const rid = received.data.resultRollId;
              const [row] = await withTenantTx(c.tenantId, (tx) =>
                tx.select({ rollNo: rolls.rollNo }).from(rolls).where(eq(rolls.id, rid)).limit(1),
              );
              resultRollNo = row?.rollNo;
            }
            await enqueuePrintReceive(
              syncOutboxRepo!,
              {
                id: received.data.id,
                resultFabricId: received.data.resultFabricId,
                resultColorId: received.data.resultColorId,
                resultRollId: received.data.resultRollId,
                resultRollNo,
              },
              body<Record<string, unknown>>(req),
              c,
              syncDeviceIdFromRequest(req),
              opIdFromRequest(req),
            );
          }
          return received;
        };
        r = syncOn() ? await withTenantTx(c.tenantId, runReceive) : await runReceive();
      } catch (err) {
        logger.error({ err }, "print receive rolled back (sync unit could not be written)");
        res.status(500).json({
          code: "SYNC_OUTBOX_FAILED",
          message: "تعذّر حفظ الاستلام مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
        });
        return;
      }
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

  router.get(
    "/printing/:id",
    auth,
    readGuard,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      const r = await uc.findPrintJobUseCase(printJobRepo, req.params.id as string, ctx(req));
      if (!r.ok) {
        return res.status(500).json({ code: "INTERNAL", message: r.error });
      }
      if (!r.data) {
        return res.status(404).json({ code: "NOT_FOUND", message: "سند الطباعة غير موجود" });
      }
      res.json(r.data);
    },
  );
}
