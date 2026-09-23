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
import type { ISyncOutboxRepository } from "../../application/ports/ISyncOutboxRepository.js";
import type { IPartyRepository } from "../../application/ports/IPartyRepository.js";
import type { IFabricRepository } from "../../application/ports/IFabricRepository.js";
import type { IColorRepository } from "../../application/ports/IColorRepository.js";
import type { IRollRepository } from "../../application/ports/IRollRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import type { CreateReturnInput } from "../../domain/entities/Return.js";
import { createReturnSchema, listReturnsSchema } from "./return.schema.js";
import * as uc from "../../application/use-cases/returns/returnUseCases.js";
import {
  enqueueReturnCancel,
  enqueueReturnCreate,
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
import { captureReturnSyncDependencies } from "../../application/use-cases/sync/syncDependencySnapshots.js";
import { logger } from "../../infrastructure/config/logger.js";
import { withTenantTx } from "../../infrastructure/orm/drizzle.js";

export function registerReturnRoutes(
  router: Router,
  returnRepo: IReturnRepository,
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
    "/returns",
    auth,
    writeGuard,
    idempotency("POST", { required: true }),
    validateBody(createReturnSchema),
    async (req: Request, res: Response) => {
      const input = body<CreateReturnInput>(req);
      const c = ctx(req);
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());

      // F-07: the return and its outbox unit share ONE transaction.
      const runCreate = async () => {
        const created = await uc.createReturnUseCase(returnRepo, auditRepo, input, c);
        if (!created.ok) return created;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          const dependencies = dependencyRepos
            ? await captureReturnSyncDependencies(dependencyRepos, input, c)
            : null;
          await enqueueReturnCreate(
            syncOutboxRepo,
            {
              id: created.data.id,
              number: created.data.number,
              kind: created.data.kind,
              partyId: created.data.partyId,
            },
            input,
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
            dependencies,
          );
        }
        return created;
      };

      let r: Awaited<ReturnType<typeof uc.createReturnUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runCreate) : await runCreate();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — return create dropped (F-07)");
        return res.status(500).json({
          code: "SYNC_OUTBOX_FAILED",
          message: "تعذّر حفظ المرتجع مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
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

  router.get(
    "/returns/:id",
    auth,
    readGuard,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      const r = await uc.findReturnUseCase(returnRepo, pid(req), ctx(req));
      if (!r.ok) {
        return res.status(500).json({ code: "INTERNAL", message: r.error });
      }
      if (!r.data) {
        return res.status(404).json({ code: "NOT_FOUND", message: "المرتجع غير موجود" });
      }
      res.json(r.data);
    },
  );

  router.post(
    "/returns/:id/cancel",
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

      // F-07: the return cancel and its outbox unit share ONE transaction.
      const runCancel = async () => {
        const cancelled = await uc.cancelReturnUseCase(returnRepo, auditRepo, pid(req), c.userId, c, expectedVersion);
        if (!cancelled.ok) return cancelled;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueReturnCancel(
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

      let r: Awaited<ReturnType<typeof uc.cancelReturnUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runCancel) : await runCancel();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — return cancel dropped (F-07)");
        return res.status(500).json({
          code: "SYNC_OUTBOX_FAILED",
          message: "تعذّر حفظ إلغاء المرتجع مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
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
