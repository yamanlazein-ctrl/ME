import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import type { IStatementRepository } from "../../application/ports/IStatementRepository.js";
import type { IPartyRepository } from "../../application/ports/IPartyRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { statementQuerySchema, settlePartySchema } from "./statement.schema.js";
import { nextDocumentNumber } from "../../infrastructure/utils/documentNumbers.js";

export function registerStatementRoutes(
  router: Router,
  statementRepo: IStatementRepository,
  partyRepo: IPartyRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
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
          const entry = await statementRepo.settle(
            req.params.id as string,
            {
              date: b.date,
              currency: b.currency,
              notesInternal: b.notesInternal,
              referenceNumber,
            },
            c,
          );
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