/**
 * REPAIR-001 (B) / REPAIR-002 — server-side report aggregates.
 */
import type { Router, Request, Response, RequestHandler } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../infrastructure/orm/drizzle.js";
import type { TenantContext } from "../../domain/types/index.js";

function ctx(req: Request): TenantContext {
  return (req as unknown as { tenantContext: TenantContext }).tenantContext;
}

export function registerReportRoutes(
  router: Router,
  auth: RequestHandler,
  readGuard: RequestHandler,
): void {
  /** Party balances — ledger remaining per currency (REPAIR-002). */
  router.get(
    "/reports/party-balances",
    auth,
    readGuard,
    async (req: Request, res: Response) => {
      const c = ctx(req);
      const kind = String(req.query.kind ?? "customer");
      const rows = await db.execute(sql`
        SELECT p.id AS "partyId", p.name, p.code, p.currency AS "partyCurrency",
               le.currency,
               CASE WHEN ${kind} = 'supplier'
                    THEN coalesce(sum(le.credit - le.debit), 0)
                    ELSE coalesce(sum(le.debit - le.credit), 0)
               END AS remaining,
               coalesce((
                 SELECT sum(i.total) FROM invoices i
                  WHERE i.tenant_id = p.tenant_id AND i.party_id = p.id
                    AND i.status = 'active'
                    AND i.type = CASE WHEN ${kind} = 'supplier' THEN 'entry' ELSE 'sale' END
                    AND i.currency = le.currency
               ), 0) AS total,
               coalesce((
                 SELECT sum(i.paid) FROM invoices i
                  WHERE i.tenant_id = p.tenant_id AND i.party_id = p.id
                    AND i.status = 'active'
                    AND i.type = CASE WHEN ${kind} = 'supplier' THEN 'entry' ELSE 'sale' END
                    AND i.currency = le.currency
               ), 0) AS paid
          FROM parties p
          LEFT JOIN ledger_entries le
            ON le.party_id = p.id AND le.tenant_id = p.tenant_id AND le.status = 'active'
         WHERE p.tenant_id = ${c.tenantId}::uuid
           AND p.kind = ${kind}
           AND p.status <> 'cancelled'
         GROUP BY p.id, p.name, p.code, p.currency, le.currency
         ORDER BY p.name`);
      res.json({ data: (rows as unknown as { rows: unknown[] }).rows ?? [] });
    },
  );
}
