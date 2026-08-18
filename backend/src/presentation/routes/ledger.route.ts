import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import {
  validateBody,
  validateQuery,
} from "../../infrastructure/http/middleware/validate.middleware.js";
import { validateUuidParam } from "../../infrastructure/http/middleware/validate-params.middleware.js";
import type { ILedgerRepository } from "../../application/ports/ILedgerRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { listLedgerSchema, writeLedgerBatchSchema } from "./ledger.schema.js";
import * as uc from "../../application/use-cases/ledger/ledgerUseCases.js";

export function registerLedgerRoutes(
  router: Router,
  ledgerRepo: ILedgerRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const pid = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  router.get(
    "/ledger",
    auth,
    readGuard,
    validateQuery(listLedgerSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listLedgerSchema>;
      const r = await uc.listLedgerUseCase(ledgerRepo, filter, ctx(req));
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );

  router.get("/ledger/balance/:partyId", auth, readGuard, async (req: Request, res: Response) => {
    const currency = (req.query.currency as string) ?? "SYP";
    const r = await uc.getPartyBalanceUseCase(ledgerRepo, req.params.partyId as string, currency, ctx(req));
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(500).json({ code: "INTERNAL", message: r.error });
    }
  });

  router.get(
    "/ledger/balance/:partyId/:date",
    auth,
    readGuard,
    async (req: Request, res: Response) => {
      const currency = (req.query.currency as string) ?? "SYP";
      const r = await uc.getPartyBalanceByDateUseCase(
        ledgerRepo,
        req.params.partyId as string,
        req.params.date as string,
        currency,
        ctx(req),
      );
      if (r.ok) {
        res.json(r.data);
      } else {
        res.status(500).json({ code: "INTERNAL", message: r.error });
      }
    },
  );

  router.get(
    "/ledger/cash-movements/:date",
    auth,
    readGuard,
    async (req: Request, res: Response) => {
      const date = req.params.date as string;
      const currency = (req.query.currency as string) ?? "SYP";
      try {
        const r = await ledgerRepo.getCashMovementsOn(date, date, currency, ctx(req));
        res.json({ in: r.in, out: r.out, date, currency });
      } catch (err) {
        res.status(400).json({ code: "VALIDATION", message: (err as Error).message ?? "Invalid date range" });
      }
    },
  );

  router.get("/ledger/party/:partyId", auth, readGuard, async (req: Request, res: Response) => {
    const r = await uc.listPartyLedgerUseCase(ledgerRepo, req.params.partyId as string, ctx(req));
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(500).json({ code: "INTERNAL", message: r.error });
    }
  });

  // Document Timeline — full ledger lifecycle of a document (created entries +
  // linked voucher entries + cancellation rows), oldest-first.
  router.get(
    "/ledger/timeline/:referenceType/:referenceId",
    auth,
    readGuard,
    validateUuidParam("referenceId"),
    async (req: Request, res: Response) => {
      try {
        const refType = req.params.referenceType as string;
        if (!/^[a-z_]{1,50}$/.test(refType)) {
          return res.status(400).json({ code: "BAD_REQUEST", message: "نوع المرجع غير صالح" });
        }
        const rows = await ledgerRepo.getDocumentTimeline(
          refType,
          req.params.referenceId as string,
          ctx(req),
        );
        res.json({ data: rows });
      } catch (err) {
        res.status(500).json({
          code: "INTERNAL",
          message: err instanceof Error ? err.message : "فشل جلب خط زمني للمستند",
        });
      }
    },
  );

  // Document Graph — full cluster of related records for an invoice (timeline,
  // linked vouchers, returns, fulfilling order). Registered before the
  // generic /ledger/:id catch-all.
  router.get(
    "/ledger/document-graph/:documentId",
    auth,
    readGuard,
    validateUuidParam("documentId"),
    async (req: Request, res: Response) => {
      try {
        const docType = (req.query.type as string) ?? "invoice";
        if (!["invoice", "voucher", "return", "order"].includes(docType)) {
          return res.status(400).json({ code: "BAD_REQUEST", message: "نوع المستند غير صالح" });
        }
        const graph = await ledgerRepo.getDocumentGraph(
          docType as "invoice" | "voucher" | "return" | "order",
          req.params.documentId as string,
          ctx(req),
        );
        res.json(graph);
      } catch (err) {
        res.status(500).json({
          code: "INTERNAL",
          message: err instanceof Error ? err.message : "فشل جلب مخطط المستند",
        });
      }
    },
  );

  router.get("/ledger/:id", auth, readGuard, validateUuidParam("id"), async (req: Request, res: Response) => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(pid(req))) {
      return res.status(404).json({ code: "NOT_FOUND", message: "القيد غير موجود" });
    }
    const r = await uc.findLedgerEntryUseCase(ledgerRepo, pid(req), ctx(req));
    if (!r.ok) {
      return res.status(500).json({ code: "INTERNAL", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "القيد غير موجود" });
    }
    res.json(r.data);
  });

  router.post(
    "/ledger",
    auth,
    writeGuard,
    validateBody(writeLedgerBatchSchema),
    async (req: Request, res: Response) => {
      const b = body<{ entries: Parameters<typeof uc.writeLedgerUseCase>[1] }>(req);
      const r = await uc.writeLedgerUseCase(ledgerRepo, b.entries, ctx(req));
      if (r.ok) {
        res.status(201).json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.post("/ledger/:id/cancel", auth, writeGuard, validateUuidParam("id"), async (req: Request, res: Response) => {
    const c = ctx(req);
    // Resolve the entry's real reference (type + id) so all rows sharing the
    // same business reference are reversed together — not a synthetic "ledger"
    // key that never matches.
    const found = await ledgerRepo.findById(pid(req), c);
    if (!found) {
      return res.status(404).json({ code: "NOT_FOUND", message: "القيد غير موجود" });
    }
    if (!found.referenceType || !found.referenceId) {
      return res.status(422).json({
        code: "VALIDATION",
        message: "هذا القيد ليس له مرجع قابل للإلغاء",
      });
    }
    const r = await uc.cancelLedgerByReferenceUseCase(
      ledgerRepo,
      found.referenceType,
      found.referenceId,
      c.userId,
      c,
    );
    if (r.ok) {
      res.json({ ok: true });
    } else if (r.code === "ALREADY_CANCELLED") {
      res.status(409).json({ code: r.code, message: "هذا المرجع تم عكسه مسبقاً" });
    } else {
      res.status(422).json({ code: "VALIDATION", message: r.error });
    }
  });
}
