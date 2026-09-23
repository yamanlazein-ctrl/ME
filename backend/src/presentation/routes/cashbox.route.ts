import type { Router, Request, Response, RequestHandler } from "express";
import { validateBody } from "../../infrastructure/http/middleware/validate.middleware.js";
import { idempotency } from "../../infrastructure/http/middleware/idempotency-handler.middleware.js";
import type { ICashboxRepository } from "../../application/ports/ICashboxRepository.js";
import type { ILedgerRepository } from "../../application/ports/ILedgerRepository.js";
import type { ISyncOutboxRepository } from "../../application/ports/ISyncOutboxRepository.js";
import type { TenantContext } from "../../domain/types/index.js";
import { randomUUID } from "node:crypto";
import { round2dp } from "@erp/shared";
import { logger } from "../../infrastructure/config/logger.js";
import { withTenantTx } from "../../infrastructure/orm/drizzle.js";
import {
  enqueueCashboxClose,
  enqueueCashboxMovement,
  enqueueCashboxMovementCancel,
  enqueueCashboxOpening,
  isSyncEnqueueEnabled,
  opIdFromRequest,
  syncDeviceIdFromRequest,
} from "../../application/use-cases/sync/syncEnqueue.js";
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
  syncOutboxRepo?: ISyncOutboxRepository,
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
      const requested = (req.query.currency as string | undefined)?.trim();
      const manual = await cashboxRepo.listManualMovements(ctx(req));

      const balanceFor = async (currency: string): Promise<number> => {
        // Each currency has its own session row — opening balance + opening DATE
        // come from THAT currency's own session, never another currency's.
        const currencySession = state.sessions.find((s) => s.currency === currency);
        const opening = currencySession?.openingBalance ?? 0;
        const from = currencySession?.openingDate ?? "0001-01-01";
        const ledger = await ledgerRepo.getCashMovementsOn(from, date, currency, ctx(req));
        let mIn = 0;
        let mOut = 0;
        for (const m of manual) {
          if (m.currency !== currency || m.date > date || m.date < from) continue;
          if (m.direction === "in") mIn += m.amount;
          else mOut += m.amount;
        }
        // 2dp decimals summed in floats — round once (no 4655.879999999999 leaks).
        return round2dp(opening + ledger.in + mIn - ledger.out - mOut);
      };

      // DFP-031 M5: without ?currency=, return a per-currency map so multi-currency
      // cash is visible. With ?currency=, keep the historical scalar number.
      if (requested) {
        res.json(await balanceFor(requested));
        return;
      }

      const currencies = new Set<string>(["SYP", "USD"]);
      for (const s of state.sessions) currencies.add(s.currency);
      for (const m of manual) currencies.add(m.currency);

      const byCurrency: Record<string, number> = {};
      for (const c of currencies) {
        byCurrency[c] = await balanceFor(c);
      }
      res.json(byCurrency);
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

  // SYNC-12: opening balance is a tenant-singleton — one winner, serialized
  // by the cashbox_opening identity claim. Same-transaction enqueue (F-07).
  router.post(
    "/cashbox/opening-balance",
    auth,
    writeGuard,
    idempotency("POST", { required: true }),
    validateBody(setOpeningBalanceSchema),
    async (req: Request, res: Response) => {
      const c = ctx(req);
      const b = body<{ openingBalance: number; openingDate: string; currency?: string }>(req);
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());
      const runSet = async () => {
        const r = await uc.setOpeningBalanceUseCase(
          cashboxRepo,
          b.openingBalance,
          b.openingDate,
          b.currency ?? "SYP",
          c,
        );
        if (!r.ok) return r;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueCashboxOpening(
            syncOutboxRepo,
            {
              openingBalance: b.openingBalance,
              openingDate: b.openingDate,
              currency: b.currency ?? "SYP",
            },
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
          );
        }
        return r;
      };
      let r: Awaited<ReturnType<typeof uc.setOpeningBalanceUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runSet) : await runSet();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — opening balance dropped (F-07)");
        return res.status(500).json({ code: "INTERNAL", message: "فشل تعيين الرصيد الافتتاحي" });
      }
      if (r.ok) {
        res.json({ ok: true });
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  // SYNC-12: manual movements are id-keyed appends — the id is pre-allocated
  // so hub replay converges on redelivery instead of duplicating cash.
  router.post(
    "/cashbox/manual-movements",
    auth,
    writeGuard,
    idempotency("POST", { required: true }),
    validateBody(addManualMovementSchema),
    async (req: Request, res: Response) => {
      const c = ctx(req);
      const input = body<Record<string, unknown>>(req) as Record<string, unknown>;
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());
      const runAdd = async () => {
        const id = randomUUID();
        const r = await uc.addManualMovementUseCase(
          cashboxRepo,
          { ...(input as object), id } as never,
          c,
        );
        if (!r.ok) return r;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueCashboxMovement(
            syncOutboxRepo,
            { id: r.data.id ?? id },
            input,
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
          );
        }
        return r;
      };
      let r: Awaited<ReturnType<typeof uc.addManualMovementUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runAdd) : await runAdd();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — manual movement dropped (F-07)");
        return res.status(500).json({ code: "INTERNAL", message: "فشل إضافة حركة يدوية" });
      }
      if (r.ok) {
        res.status(201).json(r.data);
      } else {
        const code = "code" in r && r.code ? r.code : "VALIDATION";
        res.status(422).json({ code, message: r.error });
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

  // SYNC-12: movement deletion replays by id on the hub.
  router.delete(
    "/cashbox/manual-movements/:id",
    auth,
    writeGuard,
    async (req: Request, res: Response) => {
      const c = ctx(req);
      const id = pid(req);
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());
      const runDelete = async () => {
        const r = await uc.deleteManualMovementUseCase(cashboxRepo, id, c);
        if (!r.ok) return r;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueCashboxMovementCancel(
            syncOutboxRepo,
            id,
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
          );
        }
        return r;
      };
      let r: Awaited<ReturnType<typeof uc.deleteManualMovementUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runDelete) : await runDelete();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — movement delete dropped (F-07)");
        return res.status(500).json({ code: "INTERNAL", message: "فشل حذف الحركة" });
      }
      if (r.ok) {
        res.status(204).end();
      } else {
        res.status(422).json({ code: "VALIDATION", message: r.error });
      }
    },
  );

  // SYNC-12: day-close is single-winner per date (cashbox_close claim). The
  // loser 409s and its local close is flagged — closes are never auto-undone.
  router.post(
    "/cashbox/close-day",
    auth,
    writeGuard,
    validateBody(closeDaySchema),
    async (req: Request, res: Response) => {
      const c = ctx(req);
      const input = body<Record<string, unknown>>(req) as Record<string, unknown>;
      const syncEnabled = Boolean(syncOutboxRepo && isSyncEnqueueEnabled());
      const runClose = async () => {
        const r = await uc.closeDayUseCase(cashboxRepo, input as never, c);
        if (!r.ok) return r;
        if (syncOutboxRepo && isSyncEnqueueEnabled()) {
          await enqueueCashboxClose(
            syncOutboxRepo,
            String(input.date ?? ""),
            input,
            c,
            syncDeviceIdFromRequest(req),
            opIdFromRequest(req),
          );
        }
        return r;
      };
      let r: Awaited<ReturnType<typeof uc.closeDayUseCase>>;
      try {
        r = syncEnabled ? await withTenantTx(c.tenantId, runClose) : await runClose();
      } catch (err) {
        logger.error({ err }, "transaction rolled back — day close dropped (F-07)");
        return res.status(500).json({ code: "INTERNAL", message: "فشل إقفال اليوم" });
      }
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
