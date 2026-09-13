import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import type { IStatementRepository } from "../../application/ports/IStatementRepository.js";
import type { IPartyRepository } from "../../application/ports/IPartyRepository.js";
import type { ILedgerRepository } from "../../application/ports/ILedgerRepository.js";
import type { ISyncOutboxRepository } from "../../application/ports/ISyncOutboxRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { logger } from "../../infrastructure/config/logger.js";
import { withTenantTx } from "../../infrastructure/orm/drizzle.js";
import {
  enqueueSettlement,
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
import { statementQuerySchema, settlePartySchema } from "./statement.schema.js";
import { nextDocumentNumber } from "../../infrastructure/utils/documentNumbers.js";

export function registerStatementRoutes(
  router: Router,
  statementRepo: IStatementRepository,
  partyRepo: IPartyRepository,
  ledgerRepo: ILedgerRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
  syncOutboxRepo?: ISyncOutboxRepository,
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
            logger.error({ err: txErr }, "transaction rolled back — settlement dropped (F-07)");
            return res.status(500).json({
              code: "SYNC_OUTBOX_FAILED",
              message: "تعذّر حفظ التسوية مع وحدة المزامنة — لم يُحفظ أي تغيير. أعد المحاولة.",
            });
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
