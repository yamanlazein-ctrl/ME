import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
import type { IPartyRepository } from "../../application/ports/IPartyRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { createPartySchema, updatePartySchema, listPartiesSchema } from "./party.schema.js";
import {
  createPartyUseCase,
  updatePartyUseCase,
  findPartyUseCase,
  listPartiesUseCase,
  cancelPartyUseCase,
} from "../../application/use-cases/parties/partyUseCases.js";
import type { ISyncOutboxRepository } from "../../application/ports/ISyncOutboxRepository.js";
import {
  enqueueMasterCreate,
  enqueueMasterDelete,
  enqueueMasterUpdate,
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
import { logger } from "../../infrastructure/config/logger.js";
import { withTenantTx, db } from "../../infrastructure/orm/drizzle.js";
import { mergePartiesUseCase } from "../../application/use-cases/parties/mergePartiesUseCase.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";

export function registerPartyRoutes(
  router: Router,
  partyRepo: IPartyRepository,
  auth: RequestHandler,
  accountantAndUp: RequestHandler,
  readAll: RequestHandler,
  syncOutboxRepo?: ISyncOutboxRepository,
) {
  const ctxFn = (req: Request): TenantContext => req.tenantContext!;
  const paramId = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  // F-07 (Transactional Outbox): customer/supplier creation and its outbox unit
  // are produced inside ONE `withTenantTx`, so a failed enqueue can no longer
  // leave a party saved locally that never reaches the hub.
  async function createPartyAndEnqueue(req: Request, res: Response, kind: "customer" | "supplier") {
    const input = { ...body<Record<string, unknown>>(req), kind };
    const c = ctxFn(req);
    const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());

    const runCreate = async () => {
      const result = await createPartyUseCase(
        partyRepo,
        input as Parameters<typeof createPartyUseCase>[1],
        c,
      );
      if (!result.ok) return result;
      const p = result.data;
      if (syncOutboxRepo && isSyncEnqueueEnabled()) {
        await enqueueMasterCreate(
          syncOutboxRepo,
          "party",
          p.id,
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
          c,
          syncDeviceIdFromRequest(req),
          opIdFromRequest(req),
        );
      }
      return result;
    };

    let result: Awaited<ReturnType<typeof createPartyUseCase>>;
    try {
      result = syncEnabled ? await withTenantTx(c.tenantId, runCreate) : await runCreate();
    } catch (err) {
      logger.error({ err }, "transaction rolled back — party create dropped (F-07)");
      return res.status(500).json({
        code: "SYNC_OUTBOX_FAILED",
        message: "تعذّر حفظ الطرف مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
        statusCode: 500,
      });
    }
    if (!result.ok) {
      return res.status(422).json({ code: "VALIDATION", message: result.error });
    }
    return res.status(201).json(result.data);
  }

  router.post(
    "/customers",
    auth,
    accountantAndUp,
    validateBody(createPartySchema.omit({ kind: true })),
    async (req: Request, res: Response) => createPartyAndEnqueue(req, res, "customer"),
  );

  router.post(
    "/suppliers",
    auth,
    accountantAndUp,
    validateBody(createPartySchema.omit({ kind: true })),
    async (req: Request, res: Response) => createPartyAndEnqueue(req, res, "supplier"),
  );

  router.get(
    "/parties",
    auth,
    readAll,
    validateQuery(listPartiesSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listPartiesSchema>;
      const result = await listPartiesUseCase(partyRepo, filter, ctxFn(req));
      if (result.ok) return res.json(result.data);
      return res.status(500).json({ code: "INTERNAL", message: result.error });
    },
  );

  router.get(
    "/customers",
    auth,
    readAll,
    validateQuery(listPartiesSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listPartiesSchema>;
      const result = await listPartiesUseCase(
        partyRepo,
        { ...filter, kind: "customer" },
        ctxFn(req),
      );
      if (result.ok) return res.json(result.data);
      return res.status(500).json({ code: "INTERNAL", message: result.error });
    },
  );

  router.get(
    "/suppliers",
    auth,
    readAll,
    validateQuery(listPartiesSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listPartiesSchema>;
      const result = await listPartiesUseCase(
        partyRepo,
        { ...filter, kind: "supplier" },
        ctxFn(req),
      );
      if (result.ok) return res.json(result.data);
      return res.status(500).json({ code: "INTERNAL", message: result.error });
    },
  );

  router.get(
    "/parties/:id",
    auth,
    readAll,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      const result = await findPartyUseCase(partyRepo, paramId(req), ctxFn(req));
      if (!result.ok) return res.status(500).json({ code: "INTERNAL", message: result.error });
      if (!result.data)
        return res.status(404).json({ code: "NOT_FOUND", message: "الطرف غير موجود" });
      return res.json(result.data);
    },
  );

  router.get(
    "/customers/:id",
    auth,
    readAll,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      const result = await findPartyUseCase(partyRepo, paramId(req), ctxFn(req));
      if (!result.ok) return res.status(500).json({ code: "INTERNAL", message: result.error });
      if (!result.data || result.data.kind !== "customer") {
        return res.status(404).json({ code: "NOT_FOUND", message: "العميل غير موجود" });
      }
      return res.json(result.data);
    },
  );

  router.get(
    "/suppliers/:id",
    auth,
    readAll,
    validateUuidParam("id"),
    async (req: Request, res: Response) => {
      const result = await findPartyUseCase(partyRepo, paramId(req), ctxFn(req));
      if (!result.ok) return res.status(500).json({ code: "INTERNAL", message: result.error });
      if (!result.data || result.data.kind !== "supplier") {
        return res.status(404).json({ code: "NOT_FOUND", message: "المورد غير موجود" });
      }
      return res.json(result.data);
    },
  );

  // SYNC-13: master updates/deletes enqueue sync units in the same
  // transaction as the local mutation (F-07 pattern). The pre-edit version is
  // captured so the hub can refuse stale replays instead of overwriting a
  // newer edit (P3b pattern for masters).
  async function updatePartyAndEnqueue(req: Request, res: Response) {
    const c = ctxFn(req);
    const id = paramId(req);
    const input = body<Record<string, unknown>>(req) as Record<string, unknown>;
    const expectedVersion = req.body?.expectedVersion;
    if (typeof expectedVersion !== "number") {
      return res.status(400).json({ code: "EXPECTED_VERSION_REQUIRED", message: "الإصدار المتوقع (expectedVersion) مطلوب للتحديث/الإلغاء" });
    }
    const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());
    const runUpdate = async () => {
      const before = await partyRepo.findById(id, c);
      const result = await updatePartyUseCase(partyRepo, id, input, c, expectedVersion);
      if (!result.ok) return result;
      if (syncOutboxRepo && isSyncEnqueueEnabled()) {
        await enqueueMasterUpdate(
          syncOutboxRepo,
          "party",
          id,
          input,
          c,
          syncDeviceIdFromRequest(req),
          opIdFromRequest(req),
          { version: (before as { version?: number } | null)?.version ?? null },
        );
      }
      return result;
    };
    let result: Awaited<ReturnType<typeof updatePartyUseCase>>;
    try {
      result = syncEnabled ? await withTenantTx(c.tenantId, runUpdate) : await runUpdate();
    } catch (err) {
      logger.error({ err }, "transaction rolled back — party update dropped (F-07)");
      return res.status(500).json({
        code: "INTERNAL",
        message: "فشل تحديث الطرف",
      });
    }
    if (result.ok) return res.json(result.data);
    return res.status(422).json({ code: "VALIDATION", message: result.error });
  }

  async function deletePartyAndEnqueue(req: Request, res: Response) {
    const c = ctxFn(req);
    const id = paramId(req);
    const expectedVersion = req.body?.expectedVersion;
    if (typeof expectedVersion !== "number") {
      return res.status(400).json({ code: "EXPECTED_VERSION_REQUIRED", message: "الإصدار المتوقع (expectedVersion) مطلوب للتحديث/الإلغاء" });
    }
    const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());
    const runDelete = async () => {
      const result = await cancelPartyUseCase(partyRepo, id, c.userId, c, expectedVersion);
      if (!result.ok) return result;
      if (syncOutboxRepo && isSyncEnqueueEnabled()) {
        // 4D: stamp the base the delete was based on (the client's
        // expectedVersion) so the hub can refuse a stale delete replay instead
        // of letting it win over a newer edit.
        await enqueueMasterDelete(
          syncOutboxRepo,
          "party",
          id,
          c,
          syncDeviceIdFromRequest(req),
          opIdFromRequest(req),
          { version: expectedVersion },
        );
      }
      return result;
    };
    let result: Awaited<ReturnType<typeof cancelPartyUseCase>>;
    try {
      result = syncEnabled ? await withTenantTx(c.tenantId, runDelete) : await runDelete();
    } catch (err) {
      logger.error({ err }, "transaction rolled back — party delete dropped (F-07)");
      return res.status(500).json({
        code: "INTERNAL",
        message: "فشل حذف الطرف",
      });
    }
    if (result.ok) return res.status(204).end();
    return res.status(422).json({ code: "VALIDATION", message: result.error });
  }

  router.put(
    "/customers/:id",
    auth,
    accountantAndUp,
    validateBody(updatePartySchema),
    updatePartyAndEnqueue,
  );

  router.put(
    "/suppliers/:id",
    auth,
    accountantAndUp,
    validateBody(updatePartySchema),
    updatePartyAndEnqueue,
  );

  router.delete(
    "/customers/:id",
    auth,
    accountantAndUp,
    validateUuidParam("id"),
    deletePartyAndEnqueue,
  );

  router.delete(
    "/suppliers/:id",
    auth,
    accountantAndUp,
    validateUuidParam("id"),
    deletePartyAndEnqueue,
  );

  const mergeBody = z.object({
    survivorId: z.string().uuid(),
    sourceId: z.string().uuid(),
  });

  router.post(
    "/parties/merge",
    auth,
    accountantAndUp,
    idempotency("POST", { required: true }),
    validateBody(mergeBody),
    async (req: Request, res: Response) => {
      try {
        const b = body<{ survivorId: string; sourceId: string }>(req);
        const result = await mergePartiesUseCase(db, b.survivorId, b.sourceId, ctxFn(req));
        return res.status(200).json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "فشل دمج الأطراف";
        return res.status(422).json({ code: "VALIDATION", message: msg });
      }
    },
  );
}
