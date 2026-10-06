import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
import type { IPartyRepository } from "../../application/ports/IPartyRepository.js";
import type { IInvoiceRepository } from "../../application/ports/IInvoiceRepository.js";
import type { IVoucherRepository } from "../../application/ports/IVoucherRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import {
  createPartySchema,
  updatePartySchema,
  listPartiesSchema,
  setPartyOpeningSchema,
} from "./party.schema.js";
import {
  createPartyUseCase,
  updatePartyUseCase,
  findPartyUseCase,
  listPartiesUseCase,
  cancelPartyUseCase,
} from "../../application/use-cases/parties/partyUseCases.js";
import {
  getPartyDeletionImpactUseCase,
  purgePartyCascadeUseCase,
  listPartyLinkedDocs,
} from "../../application/use-cases/parties/purgePartyCascadeUseCase.js";
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
import { withTenantTx } from "../../infrastructure/orm/engine.js";
import { mergePartiesUseCase } from "../../application/use-cases/parties/mergePartiesUseCase.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";
import { respondTransactionFailure } from "../../infrastructure/http/transactionRouteError.js";

import { localDateISO } from "../../infrastructure/utils/localDate.js";
import { guardWithPreOperationBackup } from "../../infrastructure/backup/preOperationBackup.js";

const linkedDocsQuerySchema = z.object({
  kind: z.enum(["invoice", "voucher", "return", "order"]),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(200).optional(),
  q: z.string().max(120).optional(),
});
export function registerPartyRoutes(
  router: Router,
  partyRepo: IPartyRepository,
  auth: RequestHandler,
  accountantAndUp: RequestHandler,
  readAll: RequestHandler,
  syncOutboxRepo?: ISyncOutboxRepository,
  invoiceRepo?: IInvoiceRepository,
  voucherRepo?: IVoucherRepository,
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
            // The opening journal is written locally in the same transaction
            // as the party; other devices rebuild it from these two fields.
            openingBalance: p.openingBalance ?? 0,
            openingDate: p.openingDate ?? localDateISO(new Date(p.createdAt ?? Date.now())),
            openingCurrency: p.openingCurrency ?? null,
            openingNote: p.openingNote ?? null,
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
      return respondTransactionFailure(
        res,
        err,
        "party",
        "تعذّر حفظ الطرف مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
      );
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

  const registerDeletionImpact = (base: "/customers" | "/suppliers") => {
    router.get(
      `${base}/:id/deletion-impact`,
      auth,
      readAll,
      validateUuidParam("id"),
      async (req: Request, res: Response) => {
        const result = await getPartyDeletionImpactUseCase(paramId(req), ctxFn(req));
        if (!result.ok) {
          return res.status(404).json({ code: "NOT_FOUND", message: result.error });
        }
        const expectedKind = base === "/customers" ? "customer" : "supplier";
        if (result.data.kind !== expectedKind) {
          return res.status(404).json({
            code: "NOT_FOUND",
            message: expectedKind === "customer" ? "العميل غير موجود" : "المورد غير موجود",
          });
        }
        return res.json(result.data);
      },
    );
  };
  registerDeletionImpact("/customers");
  registerDeletionImpact("/suppliers");

  // Every linked document, paged. The impact sheet is a SUMMARY with a capped
  // preview; this is the full set the operator must be able to review before
  // confirming — a customer with 1000 invoices stays reviewable page by page
  // (and searchable) instead of being truncated to the first slice.
  const registerLinkedDocs = (base: "/customers" | "/suppliers") => {
    router.get(
      `${base}/:id/linked-docs`,
      auth,
      readAll,
      validateUuidParam("id"),
      validateQuery(linkedDocsQuerySchema),
      async (req: Request, res: Response) => {
        const id = paramId(req);
        const c = ctxFn(req);
        const expectedKind = base === "/customers" ? "customer" : "supplier";
        const party = await partyRepo.findById(id, c);
        if (!party || party.kind !== expectedKind) {
          return res.status(404).json({
            code: "NOT_FOUND",
            message: expectedKind === "customer" ? "العميل غير موجود" : "المورد غير موجود",
          });
        }
        const q = req.validatedQuery as z.infer<typeof linkedDocsQuerySchema>;
        const page = await withTenantTx(c.tenantId, (tx) =>
          listPartyLinkedDocs(tx, c.tenantId, id, {
            kind: q.kind,
            partyKind: expectedKind,
            limit: q.limit,
            cursor: q.cursor ?? null,
            q: q.q,
          }),
        );
        return res.json(page);
      },
    );
  };
  registerLinkedDocs("/customers");
  registerLinkedDocs("/suppliers");

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
      return respondTransactionFailure(
        res,
        err,
        "party",
        "تعذّر تحديث الطرف مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
      );
    }
    if (result.ok) return res.json(result.data);
    return res.status(422).json({ code: "VALIDATION", message: result.error });
  }

  async function deletePartyAndEnqueue(req: Request, res: Response) {
    const c = ctxFn(req);
    const id = paramId(req);
    // Body is the primary source; query is a fallback for transports that
    // drop DELETE bodies. Never invent a version — OCC must stay closed.
    const rawExpected = req.body?.expectedVersion ?? req.query?.expectedVersion;
    const expectedVersion = typeof rawExpected === "number" ? rawExpected : Number(rawExpected);
    if (!Number.isFinite(expectedVersion)) {
      return res.status(400).json({ code: "EXPECTED_VERSION_REQUIRED", message: "الإصدار المتوقع (expectedVersion) مطلوب للتحديث/الإلغاء" });
    }
    const confirmCascade = req.body?.confirmCascade === true || req.query?.confirmCascade === "true";

    // Cascade path: cancel related invoices/vouchers via existing accounting,
    // then soft-cancel the party. OCC is re-checked on the fresh party version.
    if (confirmCascade) {
      if (!invoiceRepo || !voucherRepo) {
        return res.status(500).json({
          code: "INTERNAL",
          message: "مسار الحذف المتكامل غير مهيأ على هذا الخادم",
        });
      }
      if (!(await guardWithPreOperationBackup(res, "party-purge"))) return; // BK-4 (T097)
      const purged = await purgePartyCascadeUseCase({
        partyId: id,
        ctx: c,
        expectedVersion,
        partyRepo,
        invoiceRepo,
        voucherRepo,
      });
      if (!purged.ok) {
        return res.status(422).json({ code: "VALIDATION", message: purged.error });
      }
      if (syncOutboxRepo && isSyncEnqueueEnabled()) {
        try {
          await withTenantTx(c.tenantId, async () => {
            await enqueueMasterDelete(
              syncOutboxRepo,
              "party",
              id,
              c,
              syncDeviceIdFromRequest(req),
              opIdFromRequest(req),
              { version: expectedVersion },
            );
          });
        } catch (err) {
          logger.error({ err }, "party purge succeeded locally but sync enqueue failed");
        }
      }
      return res.status(204).end();
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
      return respondTransactionFailure(
        res,
        err,
        "party",
        "تعذّر حذف الطرف مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
      );
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

  // Opening balance replacement: body `{ opening, expectedVersion }`. Same handler as a field
  // edit, so it shares the version check and is synced as a party update whose input is
  // `{ opening }` — the hub and every device replay it through updatePartyUseCase → setOpening.
  router.put(
    "/customers/:id/opening",
    auth,
    accountantAndUp,
    validateUuidParam("id"),
    idempotency("PUT"),
    validateBody(setPartyOpeningSchema),
    updatePartyAndEnqueue,
  );

  router.put(
    "/suppliers/:id/opening",
    auth,
    accountantAndUp,
    validateUuidParam("id"),
    idempotency("PUT"),
    validateBody(setPartyOpeningSchema),
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
      // The merge remaps party_id on already-synced financial rows without
      // enqueueing sync units, so a synced device and the hub would diverge.
      // Refuse it while sync is enabled until a merge sync unit exists.
      if (syncOutboxRepo && isSyncEnqueueEnabled()) {
        return res.status(409).json({
          code: "MERGE_UNAVAILABLE_WITH_SYNC",
          message: "دمج الأطراف غير متاح عند تفعيل المزامنة",
        });
      }
      if (!(await guardWithPreOperationBackup(res, "party-merge"))) return; // BK-4 (T097)
      try {
        const b = body<{ survivorId: string; sourceId: string }>(req);
        const result = await mergePartiesUseCase(partyRepo, b.survivorId, b.sourceId, ctxFn(req));
        return res.status(200).json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "فشل دمج الأطراف";
        return res.status(422).json({ code: "VALIDATION", message: msg });
      }
    },
  );
}
