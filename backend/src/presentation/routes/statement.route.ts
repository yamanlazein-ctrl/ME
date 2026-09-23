import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import type { IStatementRepository } from "../../application/ports/IStatementRepository.js";
import type { IPartyRepository } from "../../application/ports/IPartyRepository.js";
import type { ILedgerRepository } from "../../application/ports/ILedgerRepository.js";
import type { IVoucherRepository } from "../../application/ports/IVoucherRepository.js";
import type { IAuditRepository } from "../../application/ports/IAuditRepository.js";
import type { ISyncOutboxRepository } from "../../application/ports/ISyncOutboxRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { logger } from "../../infrastructure/config/logger.js";
import { db, withTenantTx } from "../../infrastructure/orm/drizzle.js";
import { customerCreditPosition } from "../../infrastructure/repositories/customerCredit.js";
import { respondTransactionFailure } from "../../infrastructure/http/transactionRouteError.js";
import {
  enqueueSettlement,
  enqueueVoucherCreate,
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
import { capturePartySyncDependencies } from "../../application/use-cases/sync/syncDependencySnapshots.js";
import { statementQuerySchema, settlePartySchema, settleInvoicesSchema } from "./statement.schema.js";
import { nextDocumentNumber } from "../../infrastructure/utils/documentNumbers.js";
import { settleInvoicesUseCase } from "../../application/use-cases/statements/settleInvoicesUseCase.js";
import { BusinessRuleError } from "../../domain/errors/index.js";

export function registerStatementRoutes(
  router: Router,
  statementRepo: IStatementRepository,
  partyRepo: IPartyRepository,
  ledgerRepo: ILedgerRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
  syncOutboxRepo?: ISyncOutboxRepository,
  voucherRepo?: IVoucherRepository,
  auditRepo?: IAuditRepository,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;

  const registerPartyStatement = (base: "/customers" | "/suppliers") => {
    const kind: "customer" | "supplier" = base === "/customers" ? "customer" : "supplier";
    const partyLabel = kind === "customer" ? "العميل غير موجود" : "المورد غير موجود";

    // GET /api/customers/:id/statement  ·  GET /api/suppliers/:id/statement
    router.get(
      `${base}/:id/statement`,
      auth,
      readGuard,
      validateQuery(statementQuerySchema),
      async (req: Request, res: Response) => {
        try {
          // Validate UUID format before hitting the database
          const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!UUID_RE.test(req.params.id as string)) {
            return res.status(400).json({ code: "BAD_REQUEST", message: "صيغة المعرف غير صالحة" });
          }
          const party = await partyRepo.findById(req.params.id as string, ctx(req));
          if (!party || party.kind !== kind) {
            return res.status(404).json({ code: "NOT_FOUND", message: partyLabel });
          }

          const q = req.validatedQuery as z.infer<typeof statementQuerySchema>;
          const statement = await statementRepo.getStatement(
            {
              partyId: req.params.id as string,
              kind,
              fromDate: q.from,
              toDate: q.to,
              currency: q.currency,
              type: q.type,
            },
            ctx(req),
          );
          res.json(statement);
        } catch (err) {
          res.status(422).json({ code: "VALIDATION", message: (err as Error).message });
        }
      },
    );

    // GET /api/customers/:id/credit?currency=USD
    // The customer's available credit (advance payments / overpaid excess not
    // yet attached to an invoice) — drives «خصم من رصيد العميل» on a new sale.
    if (kind === "customer") {
      router.get(`${base}/:id/credit`, auth, readGuard, async (req: Request, res: Response) => {
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!UUID_RE.test(req.params.id as string)) {
          return res.status(400).json({ code: "BAD_REQUEST", message: "صيغة المعرف غير صالحة" });
        }
        const currency = typeof req.query.currency === "string" ? req.query.currency : "";
        if (!/^(SYP|USD|EUR)$/.test(currency)) {
          return res.status(400).json({ code: "BAD_REQUEST", message: "العملة مطلوبة (SYP / USD / EUR)" });
        }
        const party = await partyRepo.findById(req.params.id as string, ctx(req));
        if (!party || party.kind !== kind) {
          return res.status(404).json({ code: "NOT_FOUND", message: partyLabel });
        }
        const position = await customerCreditPosition(
          db,
          ctx(req).tenantId,
          req.params.id as string,
          currency,
        );
        res.json(position);
      });
    }

    // POST /api/customers/:id/statement/settle-invoices
    // Multi-invoice cash settlement → one SET batch + N linked vouchers.
    router.post(
      `${base}/:id/statement/settle-invoices`,
      auth,
      writeGuard,
      validateBody(settleInvoicesSchema),
      async (req: Request, res: Response) => {
        if (!voucherRepo || !auditRepo) {
          return res.status(500).json({
            code: "INTERNAL",
            message: "تسجيل الدفعات على الفواتير غير مفعّل على الخادم",
          });
        }
        const c = ctx(req);
        const b = req.validatedBody as z.infer<typeof settleInvoicesSchema>;
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!UUID_RE.test(req.params.id as string)) {
          return res.status(400).json({ code: "BAD_REQUEST", message: "صيغة المعرف غير صالحة" });
        }

        const run = async () => {
          const result = await settleInvoicesUseCase(
            voucherRepo,
            auditRepo,
            partyRepo,
            req.params.id as string,
            kind,
            {
              invoiceIds: b.invoiceIds,
              amountPaid: b.amountPaid,
              discount: b.discount,
              currency: b.currency,
              exchangeRate: b.exchangeRate,
              date: b.date,
              method: b.method,
              notesInternal: b.notesInternal,
              notesPrint: b.notesPrint,
            },
            c,
          );
          if (!result.ok) {
            throw new BusinessRuleError(result.error);
          }
          if (syncOutboxRepo && isSyncEnqueueEnabled()) {
            const deps = await capturePartySyncDependencies(partyRepo, [req.params.id as string], c);
            for (const v of result.data.vouchers) {
              await enqueueVoucherCreate(
                syncOutboxRepo,
                { id: v.id, kind: v.kind, number: v.number, partyId: v.partyId },
                {
                  kind: v.kind,
                  date: v.date,
                  partyId: v.partyId,
                  partyKind: v.partyKind,
                  invoiceId: v.invoiceId,
                  amount: v.amount,
                  discount: v.discount,
                  currency: v.currency,
                  exchangeRate: v.exchangeRate ?? undefined,
                  method: v.method,
                  notesPrint: v.notesPrint,
                  notesInternal: v.notesInternal,
                  preAllocatedNumber: v.number,
                  preAllocatedId: v.id,
                },
                c,
                syncDeviceIdFromRequest(req),
                opIdFromRequest(req),
                deps,
              );
            }
          }
          return result.data;
        };

        try {
          const data = await withTenantTx(c.tenantId, run);
          res.status(201).json(data);
        } catch (txErr) {
          logger.warn({ err: txErr }, "settle-invoices transaction rolled back");
          return respondTransactionFailure(
            res,
            txErr,
            "voucher",
            "تعذّر حفظ الدفعة — لم يُحفظ أي تغيير. أعد المحاولة.",
          );
        }
      },
    );

    // POST /api/customers/:id/statement/settle  ·  POST /api/suppliers/:id/statement/settle
    // SYNC-13: settlements post settlement ledger rows — they must reach the
    // hub, serialized per party (the hub replays settle(), which recomputes
    // the amount from live balance; a concurrent loser 409s and its local
    // settlement is reversed by reference). Same-transaction enqueue (F-07).
    router.post(
      `${base}/:id/statement/settle`,
      auth,
      writeGuard,
      validateBody(settlePartySchema),
      async (req: Request, res: Response) => {
        const c = ctx(req);
        const b = req.validatedBody as z.infer<typeof settlePartySchema>;
        try {
          // Validate UUID format before hitting the database
          const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!UUID_RE.test(req.params.id as string)) {
            return res.status(400).json({ code: "BAD_REQUEST", message: "صيغة المعرف غير صالحة" });
          }
          const party = await partyRepo.findById(req.params.id as string, c);
          if (!party || party.kind !== kind) {
            return res.status(404).json({ code: "NOT_FOUND", message: partyLabel });
          }

          const referenceNumber = await nextDocumentNumber("settlement", c.tenantId);
          const settleInput = {
            date: b.date,
            currency: b.currency,
            notesInternal: b.notesInternal,
            referenceNumber,
          };
          const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());
          const runSettle = async () => {
            const entry = await statementRepo.settle(req.params.id as string, settleInput, c);
            if (syncOutboxRepo && isSyncEnqueueEnabled()) {
              // Frozen legs: capture the exact inserted rows so the hub
              // replays them id-keyed instead of recomputing from its own
              // (possibly different) balance.
              let frozen: Array<Record<string, unknown>> = [];
              if (entry.referenceType && entry.referenceId) {
                try {
                  const legs = await ledgerRepo.list(
                    {
                      referenceType: entry.referenceType,
                      referenceId: entry.referenceId,
                      limit: 10,
                    },
                    c,
                  );
                  frozen = (legs?.data ?? []) as unknown as Array<Record<string, unknown>>;
                } catch (err) {
                  logger.warn({ err }, "settlement frozen-leg capture failed; hub will recompute");
                }
              }
              await enqueueSettlement(
                syncOutboxRepo,
                { id: req.params.id as string, kind },
                settleInput as Record<string, unknown>,
                entry.referenceType && entry.referenceId
                  ? { referenceType: entry.referenceType, referenceId: entry.referenceId }
                  : null,
                c,
                syncDeviceIdFromRequest(req),
                opIdFromRequest(req),
                frozen,
              );
            }
            return entry;
          };
          let entry: Awaited<ReturnType<typeof statementRepo.settle>>;
          try {
            entry = syncEnabled ? await withTenantTx(c.tenantId, runSettle) : await runSettle();
          } catch (txErr) {
            // Known business-rule failures (e.g. a concurrent settlement that
            // already zeroed the balance) are NOT sync/outbox failures — the
            // transaction rolled back cleanly with no partial writes, and the
            // caller just lost a race. Report them as 422 VALIDATION so the
            // client can show the real reason instead of a generic 500.
            logger.warn({ err: txErr }, "settlement transaction rolled back");
            return respondTransactionFailure(
              res,
              txErr,
              "generic",
              "تعذّر حفظ التسوية مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
            );
          }
          res.status(201).json({ entry, referenceNumber, kind });
        } catch (err) {
          const message = (err as Error).message;
          res.status(message.includes("الرصيد صفر") ? 422 : 500).json({
            code: message.includes("الرصيد صفر") ? "VALIDATION" : "INTERNAL",
            message,
          });
        }
      },
    );
  };

  registerPartyStatement("/customers");
  registerPartyStatement("/suppliers");
}
