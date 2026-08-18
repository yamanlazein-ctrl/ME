import type { Router, Request, Response, RequestHandler } from "express";
import { validateBody } from "../../infrastructure/http/middleware/validate.middleware.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";
import type { ICashboxRepository } from "../../application/ports/ICashboxRepository.js";
import type { ILedgerRepository } from "../../application/ports/ILedgerRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import {
  setOpeningBalanceSchema,
  addManualMovementSchema,
  closeDaySchema,
} from "./cashbox.schema.js";
import * as uc from "../../application/use-cases/cashbox/cashboxUseCases.js";

export function registerCashboxRoutes(
  router: Router,
  cashboxRepo: ICashboxRepository,
  ledgerRepo: ILedgerRepository,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;
  const pid = (req: Request): string => req.params.id as string;
  const body = <T>(req: Request): T => (req as unknown as { validatedBody: T }).validatedBody;

  router.get("/cashbox/state", auth, readGuard, async (req: Request, res: Response) => {
    const r = await uc.getCashboxStateUseCase(cashboxRepo, ctx(req));
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(500).json({ code: "INTERNAL", message: r.error });
    }
  });

  router.get("/cashbox/balance/:date", auth, readGuard, async (req: Request, res: Response) => {
    try {
      const date = req.params.date as string;
      const state = await cashboxRepo.getState(ctx(req));
      const currency = (req.query.currency as string) || state.session?.currency || "SYP";
      const opening = state.session?.openingBalance ?? 0;
      const from = state.session?.openingDate ?? "0001-01-01";
      const [ledger, manual] = await Promise.all([
        ledgerRepo.getCashMovementsOn(from, date, currency, ctx(req)),
        cashboxRepo.listManualMovements(ctx(req)),
      ]);
      let mIn = 0;
      let mOut = 0;
      for (const m of manual) {
        if (m.currency !== currency || m.date > date || m.date < from) continue;
        if (m.direction === "in") mIn += m.amount;
        else mOut += m.amount;
      }
      res.json(opening + ledger.in + mIn - ledger.out - mOut);
    } catch (e) {
      res.status(500).json({
        code: "INTERNAL",
        message: e instanceof Error ? e.message : "فشل حساب الرصيد",
      });
    }
  });

  router.get("/cashbox/movements/:date", auth, readGuard, async (req: Request, res: Response) => {
    try {
      const date = req.params.date as string;
      const state = await cashboxRepo.getState(ctx(req));
      const currency = (req.query.currency as string) || state.session?.currency || "SYP";
      const [ledger, manual] = await Promise.all([
        ledgerRepo.getCashMovementsOn(date, date, currency, ctx(req)),
        cashboxRepo.listManualMovements(ctx(req)),
      ]);
      let mIn = 0;
      let mOut = 0;
      for (const m of manual) {
        if (m.currency !== currency || m.date !== date) continue;
        if (m.direction === "in") mIn += m.amount;
        else mOut += m.amount;
      }
      res.json({ in: ledger.in + mIn, out: ledger.out + mOut });
    } catch (e) {
      res.status(500).json({
        code: "INTERNAL",
        message: e instanceof Error ? e.message : "فشل حساب الحركات",
      });
    }
  });

  router.post(
    "/cashbox/opening-balance",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(setOpeningBalanceSchema),
    async (req: Request, res: Response) => {
      const b = body<{ openingBalance: number; openingDate: string; currency?: string }>(req);
      const r = await uc.setOpeningBalanceUseCase(
        cashboxRepo,
        b.openingBalance,
        b.openingDate,
        b.currency ?? "SYP",
        ctx(req),
      );
      if (r.ok) {
        res.json({ ok: true });
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.post(
    "/cashbox/manual-movements",
    auth,
    writeGuard,
    idempotency("POST"),
    validateBody(addManualMovementSchema),
    async (req: Request, res: Response) => {
      const r = await uc.addManualMovementUseCase(cashboxRepo, body(req), ctx(req));
      if (r.ok) {
        res.status(201).json(r.data);
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.get("/cashbox/locked/:date", auth, readGuard, async (req: Request, res: Response) => {
    const r = await uc.isDayLockedUseCase(cashboxRepo, req.params.date as string, ctx(req));
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(500).json({ code: "INTERNAL", message: r.error });
    }
  });

  router.get("/cashbox/manual-movements", auth, readGuard, async (req: Request, res: Response) => {
    const r = await uc.listManualMovementsUseCase(cashboxRepo, ctx(req));
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(500).json({ code: "INTERNAL", message: r.error });
    }
  });

  router.delete(
    "/cashbox/manual-movements/:id",
    auth,
    writeGuard,
    async (req: Request, res: Response) => {
      const r = await uc.deleteManualMovementUseCase(cashboxRepo, pid(req), ctx(req));
      if (r.ok) {
        res.status(204).end();
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  router.post(
    "/cashbox/close-day",
    auth,
    writeGuard,
    validateBody(closeDaySchema),
    async (req: Request, res: Response) => {
      const r = await uc.closeDayUseCase(cashboxRepo, body(req), ctx(req));
      if (r.ok) {
        res.status(201).json(r.data);
      } else {
        res.status(409).json({ code: "DAY_LOCKED", message: r.error });
      }
    },
  );

  router.get("/cashbox/closings", auth, readGuard, async (req: Request, res: Response) => {
    const r = await uc.getClosingsUseCase(cashboxRepo, ctx(req));
    if (r.ok) {
      res.json(r.data);
    } else {
      res.status(500).json({ code: "INTERNAL", message: r.error });
    }
  });

  router.get("/cashbox/closings/last", auth, readGuard, async (req: Request, res: Response) => {
    const r = await uc.getLastClosingUseCase(cashboxRepo, ctx(req));
    if (!r.ok) {
      return res.status(500).json({ code: "INTERNAL", message: r.error });
    }
    if (!r.data) {
      return res.status(404).json({ code: "NOT_FOUND", message: "لا يوجد إقفال سابق" });
    }
    res.json(r.data);
  });
}
