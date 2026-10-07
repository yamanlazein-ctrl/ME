import { Router, type Request, type Response, type RequestHandler } from "express";
import { z } from "zod";
import { validateBody, validateQuery } from "../../infrastructure/http/middleware/validate.middleware.js";
import { withTenantTx } from "../../infrastructure/orm/engine.js";
import { financialYearHelpers, inventoryCountHelpers } from "../../infrastructure/repositories/engineHelpers.js";
import type { ISyncOutboxRepository } from "../../application/ports/ISyncOutboxRepository.js";
import { enqueueRollAdjustment, isSyncEnqueueEnabled } from "../../application/use-cases/sync/syncEnqueue.js";
import { respondTransactionFailure } from "../../infrastructure/http/transactionRouteError.js";
import { BusinessRuleError, DayLockedError } from "../../domain/errors/index.js";
import type { TenantContext } from "../../domain/types/index.js";
import { logger } from "../../infrastructure/config/logger.js";
import { guardWithPreOperationBackup } from "../../infrastructure/backup/preOperationBackup.js";

/**
 * Year-end closing + physical inventory count.
 *
 * Every write runs inside `withTenantTx`, so a failure anywhere unwinds the
 * whole operation: there is no state where the count is posted but the year is
 * not closed, or the reverse. Nothing on this router deletes a financial row.
 *
 * Reopen is admin-only and always audited; the year guard (`assertYearOpen`,
 * in dayLockHelper) blocks ordinary writes dated inside a closed year.
 */

const yearParam = z.coerce.number().int().min(2000).max(2999);

const closeBodySchema = z.object({
  year: yearParam,
  /** Typed, so a stray click can never close a year. */
  confirm: z.literal("إقفال"),
  reason: z.string().max(500).optional(),
});

const reopenBodySchema = z.object({
  year: yearParam,
  reason: z.string().min(5, "سبب إعادة الفتح إلزامي").max(500),
});

const countBodySchema = z.object({
  year: yearParam,
  rollId: z.string().uuid(),
  countedKg: z.number().min(0).finite().nullable(),
  countedPieces: z.number().int().min(0).nullable().optional(),
  reason: z.string().max(500).optional(),
});

const postBodySchema = z.object({ countId: z.string().uuid() });

const countQuerySchema = z.object({
  year: yearParam,
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().uuid().optional(),
});

/** `validateBody` / `validateQuery` store the PARSED result, not the raw input. */
function parsed<T>(req: Request): T {
  const carrier = req as unknown as { validatedBody?: T; validatedQuery?: T };
  return (carrier.validatedBody ?? carrier.validatedQuery) as T;
}

function fail(res: Response, err: unknown, fallback: string): void {
  if (err instanceof BusinessRuleError || err instanceof DayLockedError) {
    res.status(422).json({ code: "VALIDATION", message: err.message, statusCode: 422 });
    return;
  }
  respondTransactionFailure(res, err, "generic", fallback);
}

export function registerYearClosingRoutes(
  router: Router,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
  adminGuard: RequestHandler,
  syncOutboxRepo?: ISyncOutboxRepository,
): void {
  const ctxOf = (req: Request): TenantContext => req.tenantContext!;

  router.get(
    "/financial-years",
    auth,
    readGuard,
    async (req: Request, res: Response) => {
      try {
        const years = await withTenantTx(ctxOf(req).tenantId, async (tx) =>
          (await financialYearHelpers()).listFinancialYears(tx, ctxOf(req)),
        );
        return res.json(years);
      } catch (err) {
        return fail(res, err, "تعذّر تحميل السنوات المالية.");
      }
    },
  );

  /** Read-only dry run: the checklist + the numbers the close dialog shows. */
  router.get(
    "/financial-years/:year/closing-preview",
    auth,
    readGuard,
    async (req: Request, res: Response) => {
      const year = Number(req.params.year);
      if (!yearParam.safeParse(year).success) {
        return res.status(400).json({ code: "BAD_REQUEST", message: "سنة غير صالحة." });
      }
      try {
        const preview = await withTenantTx(ctxOf(req).tenantId, async (tx) =>
          (await financialYearHelpers()).getYearClosingPreview(tx, ctxOf(req), year),
        );
        return res.json(preview);
      } catch (err) {
        return fail(res, err, "تعذّر حساب معاينة الإقفال.");
      }
    },
  );

  router.post(
    "/financial-years/begin-counting",
    auth,
    writeGuard,
    validateBody(z.object({ year: yearParam })),
    async (req: Request, res: Response) => {
      const { year } = parsed<{ year: number }>(req);
      try {
        const result = await withTenantTx(ctxOf(req).tenantId, async (tx) =>
          (await financialYearHelpers()).beginYearCounting(tx, ctxOf(req), year),
        );
        return res.json(result);
      } catch (err) {
        return fail(res, err, "تعذّر بدء الجرد.");
      }
    },
  );

  /** Keyset-paginated count sheet — never loads every roll into the WebView. */
  router.get(
    "/financial-years/count-sheet",
    auth,
    readGuard,
    validateQuery(countQuerySchema),
    async (req: Request, res: Response) => {
      const { year, limit, cursor } = parsed<z.infer<typeof countQuerySchema>>(req);
      try {
        const sheet = await withTenantTx(ctxOf(req).tenantId, async (tx) =>
          (await inventoryCountHelpers()).getCountSheet(tx, ctxOf(req), year, { limit, cursor }),
        );
        return res.json(sheet);
      } catch (err) {
        return fail(res, err, "تعذّر تحميل ورقة الجرد.");
      }
    },
  );

  router.post(
    "/financial-years/counts",
    auth,
    writeGuard,
    validateBody(countBodySchema),
    async (req: Request, res: Response) => {
      const body = parsed<z.infer<typeof countBodySchema>>(req);
      try {
        const result = await withTenantTx(ctxOf(req).tenantId, async (tx) =>
          (await inventoryCountHelpers()).recordCount(
            tx,
            ctxOf(req),
            body.year,
            body.rollId,
            body.countedKg,
            body.countedPieces ?? null,
            body.reason,
          ),
        );
        return res.json(result);
      } catch (err) {
        return fail(res, err, "تعذّر تسجيل الجرد.");
      }
    },
  );

  /** Post a variance: a real stock movement + accounting entry, never a raw edit. */
  router.post(
    "/financial-years/counts/post",
    auth,
    writeGuard,
    validateBody(postBodySchema),
    async (req: Request, res: Response) => {
      const { countId } = parsed<z.infer<typeof postBodySchema>>(req);
      try {
        const result = await withTenantTx(ctxOf(req).tenantId, async (tx) => {
          const posted = await (await inventoryCountHelpers()).postCountVariance(tx, ctxOf(req), countId);
          // The shelf changed: every device must apply the same correction.
          if (posted.adjustment && syncOutboxRepo && isSyncEnqueueEnabled()) {
            await enqueueRollAdjustment(syncOutboxRepo, ctxOf(req), posted.adjustment, req);
          }
          return posted;
        });
        return res.json({ rollId: result.rollId, diffKg: result.diffKg, movementId: result.movementId });
      } catch (err) {
        return fail(res, err, "تعذّر ترحيل تسوية الجرد.");
      }
    },
  );

  /** The close. One transaction; typed confirmation; no deletions. */
  router.post(
    "/financial-years/close",
    auth,
    writeGuard,
    validateBody(closeBodySchema),
    async (req: Request, res: Response) => {
      const body = parsed<z.infer<typeof closeBodySchema>>(req);
      if (!(await guardWithPreOperationBackup(res, "year-close"))) return; // BK-4 (T097)
      try {
        const result = await withTenantTx(ctxOf(req).tenantId, async (tx) =>
          (await financialYearHelpers()).closeFinancialYear(tx, ctxOf(req), body.year, body.reason),
        );
        logger.info(
          { tenantId: ctxOf(req).tenantId, year: body.year },
          "FINANCIAL_YEAR_CLOSED",
        );
        return res.json(result);
      } catch (err) {
        logger.error({ err, year: body.year }, "FINANCIAL_YEAR_CLOSE_FAILED");
        return fail(res, err, "تعذّر إقفال السنة، وتم التراجع عن كل التغييرات.");
      }
    },
  );

  /** Admin-only, reason-mandatory, always audited. */
  router.post(
    "/financial-years/reopen",
    auth,
    adminGuard,
    validateBody(reopenBodySchema),
    async (req: Request, res: Response) => {
      const body = parsed<z.infer<typeof reopenBodySchema>>(req);
      if (!(await guardWithPreOperationBackup(res, "year-reopen"))) return; // BK-4 (T097)
      try {
        const result = await withTenantTx(ctxOf(req).tenantId, async (tx) =>
          (await financialYearHelpers()).reopenFinancialYear(tx, ctxOf(req), body.year, body.reason),
        );
        logger.warn(
          { tenantId: ctxOf(req).tenantId, year: body.year, by: ctxOf(req).userName },
          "FINANCIAL_YEAR_REOPENED",
        );
        return res.json(result);
      } catch (err) {
        return fail(res, err, "تعذّرت إعادة فتح السنة.");
      }
    },
  );
}