/**
 * REPAIR-001 (B) / REPAIR-002 — server-side report aggregates.
 */
import type { Router, Request, Response, RequestHandler } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../infrastructure/orm/drizzle.js";
import type { TenantContext } from "../../domain/types/index.js";
import * as agg from "../../infrastructure/repositories/reportAggregates.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `from` query param → ISO date or null (all time). Anything else is rejected. */
function parseFrom(raw: unknown): string | null | "invalid" {
  if (raw == null || raw === "" || raw === "all") return null;
  const v = String(raw);
  return DATE_RE.test(v) ? v : "invalid";
}

/** numeric columns come back as strings from pg — normalize money/qty fields. */
const NUMERIC_KEYS = new Set(["total", "paid", "remaining", "amount", "debit", "credit"]);
function normalizeRow(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) out[k] = NUMERIC_KEYS.has(k) && v != null ? Number(v) : v;
  return out;
}

function ctx(req: Request): TenantContext {
  return (req as unknown as { tenantContext: TenantContext }).tenantContext;
}

export function registerReportRoutes(
  router: Router,
  auth: RequestHandler,
  readGuard: RequestHandler,
): void {
  /**
   * Reports overview — every KPI aggregated in SQL (was: every invoice, return
   * and expense downloaded and summed in the browser).
   */
  router.get("/reports/summary", auth, readGuard, async (req: Request, res: Response) => {
    const c = ctx(req);
    const from = parseFrom(req.query.from);
    if (from === "invalid") {
      return res.status(400).json({ code: "BAD_REQUEST", message: "تاريخ غير صالح" });
    }
    const [sales, purchases, salesReturns, entryReturns, expenses, inventory, fabricsTop, customersTop] =
      await Promise.all([
        agg.invoiceTotalsByCurrency(db, c.tenantId, "sale", from),
        agg.invoiceTotalsByCurrency(db, c.tenantId, "entry", from),
        agg.returnTotalsByCurrency(db, c.tenantId, "sale", from),
        agg.returnTotalsByCurrency(db, c.tenantId, "entry", from),
        agg.expenseTotalsByCurrency(db, c.tenantId, from),
        agg.inventoryValue(db, c.tenantId),
        agg.topFabrics(db, c.tenantId, from, 5),
        agg.topCustomers(db, c.tenantId, from, 5, "usdFirst"),
      ]);
    return res.json({
      from,
      sales: sales.total,
      purchases: purchases.total,
      salesReturns: salesReturns.total,
      entryReturns: entryReturns.total,
      expenses: expenses.total,
      inventoryValue: inventory.value,
      totalKg: inventory.totalKg,
      rollCount: inventory.rollCount,
      topFabrics: fabricsTop,
      topCustomers: customersTop,
    });
  });

  /** One report page: full-period summary (SQL) + paged rows. */
  router.get("/reports/detail/:slug", auth, readGuard, async (req: Request, res: Response) => {
    const c = ctx(req);
    const slug = String(req.params.slug);
    const from = parseFrom(req.query.from);
    if (from === "invalid") {
      return res.status(400).json({ code: "BAD_REQUEST", message: "تاريخ غير صالح" });
    }
    const page = Math.max(0, Math.floor(Number(req.query.page ?? 0)) || 0);
    const limit = Math.min(500, Math.max(1, Math.floor(Number(req.query.limit ?? 100)) || 100));

    let summary: Record<string, unknown>;
    switch (slug) {
      case "net-sales":
      case "purchases": {
        const t = await agg.invoiceTotalsByCurrency(db, c.tenantId, slug === "net-sales" ? "sale" : "entry", from);
        summary = { count: t.count, total: t.total, paid: t.paid, remaining: t.remaining };
        break;
      }
      case "sales-returns": {
        const t = await agg.returnTotalsByCurrency(db, c.tenantId, "sale", from);
        summary = { count: t.count, total: t.total };
        break;
      }
      case "expenses": {
        const t = await agg.expenseTotalsByCurrency(db, c.tenantId, from);
        summary = { count: t.count, total: t.total };
        break;
      }
      case "ledger": {
        const t = await agg.ledgerTotalsByCurrency(db, c.tenantId, from);
        summary = { count: t.count, debit: t.debit, credit: t.credit };
        break;
      }
      case "cashbox":
        summary = {};
        break;
      case "inventory-value": {
        const byFabric = await agg.inventoryByFabric(db, c.tenantId);
        const total: agg.ByCurrency = {};
        for (const f of byFabric)
          for (const [ccy, v] of Object.entries(f.value)) total[ccy] = (total[ccy] ?? 0) + v;
        return res.json({ summary: { total }, rows: byFabric, meta: { total: byFabric.length, page: 0, limit: byFabric.length, hasNext: false } });
      }
      case "top-fabrics": {
        const top = await agg.topFabrics(db, c.tenantId, from, 10);
        return res.json({ summary: {}, rows: top, meta: { total: top.length, page: 0, limit: 10, hasNext: false } });
      }
      case "top-customers": {
        const top = await agg.topCustomers(db, c.tenantId, from, 10, "syp");
        return res.json({ summary: {}, rows: top, meta: { total: top.length, page: 0, limit: 10, hasNext: false } });
      }
      default:
        return res.status(404).json({ code: "NOT_FOUND", message: "التقرير غير موجود" });
    }
    const paged = await agg.pagedRows(db, c.tenantId, slug, from, { page, limit });
    const total = paged?.total ?? 0;
    return res.json({
      summary,
      rows: (paged?.rows ?? []).map(normalizeRow),
      meta: { total, page, limit, hasNext: (page + 1) * limit < total },
    });
  });

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
