import type { Router, Request, Response, RequestHandler } from "express";
import { z } from "zod";
import { validateQuery } from "../../infrastructure/http/middleware/validate.middleware.js";
import type { IAuditRepository } from "../../application/ports/IAuditRepository.js";
import type { TenantContext } from "../../domain/types/index.js";

/**
 * Audit Log Query Schema — صفحة تتبع فواتير (Invoice Tracking Page)
 */
const listAuditLogsSchema = z.object({
  entityType: z.string().optional(),
  entityId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  module: z.string().optional(),
  action: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
  offset: z.coerce.number().min(0).optional().default(0),
});

export function registerAuditRoutes(
  router: Router,
  auditRepo: IAuditRepository,
  auth: RequestHandler,
  readGuard: RequestHandler,
) {
  const ctx = (req: Request): TenantContext => req.tenantContext!;

  /**
   * GET /api/audit-logs
   *
   * Query audit logs with filters. Primary use case: صفحة تتبع فواتير
   * (invoice tracking page) where user sees full history of an invoice:
   * - Created by who, when
   - - Cancelled by who, when
   * - Any modifications (before/after snapshots)
   *
   * Query params:
   *   entityType=invoice&entityId=<uuid>  → track one invoice
   *   actorId=<uuid>                      → all actions by one user
   *   module=invoices                     → all invoice actions
   *   fromDate=2024-01-01&toDate=2024-12-31 → date range
   */
  router.get(
    "/audit-logs",
    auth,
    readGuard,
    validateQuery(listAuditLogsSchema),
    async (req: Request, res: Response) => {
      const filter = req.validatedQuery as z.infer<typeof listAuditLogsSchema>;
      const r = await auditRepo.list(filter, ctx(req));
      res.json(r);
    },
  );

  /**
   * GET /api/audit-logs/invoice/:id
   *
   * Convenience endpoint for invoice tracking — returns all audit logs
   * for a specific invoice, sorted newest-first.
   */
  router.get("/audit-logs/invoice/:id", auth, readGuard, async (req: Request, res: Response) => {
    const r = await auditRepo.list(
      {
        entityType: "invoice",
        entityId: req.params.id as string,
        limit: 100,
        offset: 0,
      },
      ctx(req),
    );
    res.json(r);
  });
}
