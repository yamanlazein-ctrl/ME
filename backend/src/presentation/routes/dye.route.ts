import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { validateBody } from "../../infrastructure/http/middleware/validate.middleware.js";
import { withTenantTx } from "../../infrastructure/orm/engine.js";
import type { PurgeActor } from "../../infrastructure/repositories/dyePurgeRepository.js";
import { dyePurgeHelpers } from "../../infrastructure/repositories/engineHelpers.js";
import { logger } from "../../infrastructure/config/logger.js";
import { guardWithPreOperationBackup } from "../../infrastructure/backup/preOperationBackup.js";

/**
 * Corrective cascade endpoints for an inventory dye (fabric).
 *
 * Deliberately two steps: an impact read that writes nothing, then a purge the
 * operator must type to confirm. Both run inside `withTenantTx`, so a failure
 * anywhere in the cascade rolls back to zero change — including the trigger
 * drop the ledger append-only rule requires.
 */
const purgeBodySchema = z.object({
  /** Operator must retype either this word or the fabric's own name. */
  confirmation: z.string().min(1),
  reason: z.string().max(500).optional(),
});

const CONFIRM_WORD = "تأكيد";

function actorFrom(req: Request): PurgeActor {
  const tc = req.tenantContext;
  return { id: tc?.userId ?? null, name: tc?.userName ?? null };
}

/** `validateBody` stores the PARSED result, not the raw body. */
function validated<T>(req: Request): T {
  const carrier = req as unknown as { validatedBody?: T };
  if (carrier.validatedBody === undefined) {
    throw new Error("purge handler reached without validateBody");
  }
  return carrier.validatedBody;
}

export function registerDyeRoutes(
  router: Router,
  auth: RequestHandler,
  writeGuard: RequestHandler,
  readGuard: RequestHandler,
): void {
  const pid = (req: Request): string => req.params.id as string;

  /**
   * Dry run. Read-only: answers "what would this remove, and what money moves"
   * before the operator is asked to confirm anything.
   */
  router.get(
    "/inventory/dyes/:id/deletion-impact",
    auth,
    readGuard,
    async (req: Request, res: Response) => {
      const tenantId = req.tenantContext!.tenantId;
      try {
        const impact = await withTenantTx(tenantId, async (tx) =>
          (await dyePurgeHelpers()).computeDyePurgeImpact(tx, tenantId, pid(req)),
        );
        return res.json(impact);
      } catch (err) {
        if ((err as { code?: string }).code === "DYE_NOT_FOUND") {
          return res.status(404).json({ code: "NOT_FOUND", message: "الصبغة غير موجودة." });
        }
        throw err;
      }
    },
  );

  /**
   * The purge. One transaction, reverse-dependency order, and a typed
   * confirmation so it can never be triggered by a stray click.
   */
  router.delete(
    "/inventory/dyes/:id/purge",
    auth,
    writeGuard,
    validateBody(purgeBodySchema),
    async (req: Request, res: Response) => {
      const tenantId = req.tenantContext!.tenantId;
      const fabricId = pid(req);
      const input = validated<z.infer<typeof purgeBodySchema>>(req);
      const typed = input.confirmation.trim();

      // Confirm against the fabric's CURRENT name: it may have been renamed
      // since the impact dialog opened.
      const expected = await withTenantTx(tenantId, async (tx) => {
        const h = await dyePurgeHelpers();
        if (!(await h.dyeExists(tx, tenantId, fabricId))) return null;
        const impact = await h.computeDyePurgeImpact(tx, tenantId, fabricId);
        return impact.fabricName ?? fabricId;
      });
      if (expected === null) {
        return res.status(404).json({ code: "NOT_FOUND", message: "الصبغة غير موجودة." });
      }
      if (typed !== CONFIRM_WORD && typed !== expected) {
        return res.status(400).json({
          code: "CONFIRMATION_MISMATCH",
          message: `للتأكيد اكتب «${CONFIRM_WORD}» أو اسم الصبغة كما هو.`,
        });
      }

      if (!(await guardWithPreOperationBackup(res, "dye-purge"))) return; // BK-4 (T097)
      try {
        const result = await withTenantTx(tenantId, async (tx) =>
          (await dyePurgeHelpers()).purgeDyeCascade(tx, tenantId, fabricId, {
            ...actorFrom(req),
            reason: input.reason ?? null,
          }),
        );
        logger.info({ tenantId, ...result }, "DYE_CASCADE_PURGE");
        return res.json(result);
      } catch (err) {
        // Already rolled back. Surface the real cause rather than a generic
        // failure — the operator needs to know what blocked the purge.
        logger.error({ err, tenantId, fabricId }, "DYE_CASCADE_PURGE_FAILED");
        return res.status(409).json({
          code: "PURGE_FAILED",
          message: `تعذّر إتمام الحذف التصحيحي، وتم التراجع عن كل التغييرات. السبب: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    },
  );
}
