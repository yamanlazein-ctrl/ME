/**
 * REPAIR-001 (B) / REPAIR-002 — server-side report aggregates.
 */
import type { Router, Request, Response, RequestHandler } from "express";
import type { TenantContext } from "../../domain/types/index.js";
import type { IReportsRepository, ByCurrency } from "../../application/ports/IReportsRepository.js";

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
  reports: IReportsRepository,
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
        reports.invoiceTotalsByCurrency(c.tenantId, "sale", from),
        reports.invoiceTotalsByCurrency(c.tenantId, "entry", from),
        reports.returnTotalsByCurrency(c.tenantId, "sale", from),
        reports.returnTotalsByCurrency(c.tenantId, "entry", from),
        reports.expenseTotalsByCurrency(c.tenantId, from),
        reports.inventoryValue(c.tenantId),
        reports.topFabrics(c.tenantId, from, 5),
        reports.topCustomers(c.tenantId, from, 5, "usdFirst"),
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
        const t = await reports.invoiceTotalsByCurrency(c.tenantId, slug === "net-sales" ? "sale" : "entry", from);
        summary = { count: t.count, total: t.total, paid: t.paid, remaining: t.remaining };
        break;
      }
      case "sales-returns": {
        const t = await reports.returnTotalsByCurrency(c.tenantId, "sale", from);
        summary = { count: t.count, total: t.total };
        break;
      }
      case "expenses": {
        const t = await reports.expenseTotalsByCurrency(c.tenantId, from);
        summary = { count: t.count, total: t.total };
        break;
      }
      case "ledger": {
        const t = await reports.ledgerTotalsByCurrency(c.tenantId, from);
        summary = { count: t.count, debit: t.debit, credit: t.credit };
        break;
      }
      case "cashbox":
        summary = {};
        break;
      case "inventory-value": {
        const byFabric = await reports.inventoryByFabric(c.tenantId);
        const total: ByCurrency = {};
        for (const f of byFabric)
          for (const [ccy, v] of Object.entries(f.value)) total[ccy] = (total[ccy] ?? 0) + v;
        return res.json({ summary: { total }, rows: byFabric, meta: { total: byFabric.length, page: 0, limit: byFabric.length, hasNext: false } });
      }
      case "top-fabrics": {
        const top = await reports.topFabrics(c.tenantId, from, 10);
        return res.json({ summary: {}, rows: top, meta: { total: top.length, page: 0, limit: 10, hasNext: false } });
      }
      case "top-customers": {
        const top = await reports.topCustomers(c.tenantId, from, 10, "syp");
        return res.json({ summary: {}, rows: top, meta: { total: top.length, page: 0, limit: 10, hasNext: false } });
      }
      default:
        return res.status(404).json({ code: "NOT_FOUND", message: "التقرير غير موجود" });
    }
    const paged = await reports.pagedRows(c.tenantId, slug, from, { page, limit });
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
      res.json({ data: await reports.partyBalances(c.tenantId, kind) });
    },
  );
}
