/**
 * PostgreSQL report aggregates. Delegates to the existing reportAggregates helpers and
 * holds the party-balances query moved verbatim from reports.route.ts (S1). Unchanged behavior.
 */
import { sql } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type { IReportsRepository, ReportRow } from "../../application/ports/IReportsRepository.js";
import * as agg from "./reportAggregates.js";

export class PostgresReportsRepository implements IReportsRepository {
  constructor(private readonly db: DB) {}

  invoiceTotalsByCurrency(tenantId: string, type: "sale" | "entry", from: string | null) {
    return agg.invoiceTotalsByCurrency(this.db, tenantId, type, from);
  }
  returnTotalsByCurrency(tenantId: string, kind: "sale" | "entry", from: string | null) {
    return agg.returnTotalsByCurrency(this.db, tenantId, kind, from);
  }
  expenseTotalsByCurrency(tenantId: string, from: string | null) {
    return agg.expenseTotalsByCurrency(this.db, tenantId, from);
  }
  inventoryValue(tenantId: string) {
    return agg.inventoryValue(this.db, tenantId);
  }
  inventoryByFabric(tenantId: string) {
    return agg.inventoryByFabric(this.db, tenantId);
  }
  topFabrics(tenantId: string, from: string | null, limit: number) {
    return agg.topFabrics(this.db, tenantId, from, limit);
  }
  topCustomers(tenantId: string, from: string | null, limit: number, order: "usdFirst" | "syp") {
    return agg.topCustomers(this.db, tenantId, from, limit, order);
  }
  ledgerTotalsByCurrency(tenantId: string, from: string | null) {
    return agg.ledgerTotalsByCurrency(this.db, tenantId, from);
  }
  pagedRows(tenantId: string, slug: string, from: string | null, page: { page: number; limit: number }) {
    return agg.pagedRows(this.db, tenantId, slug, from, page);
  }

  async partyBalances(tenantId: string, kind: string): Promise<ReportRow[]> {
    const rows = await this.db.execute(sql`
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
         WHERE p.tenant_id = ${tenantId}::uuid
           AND p.kind = ${kind}
           AND p.status <> 'cancelled'
         GROUP BY p.id, p.name, p.code, p.currency, le.currency
         ORDER BY p.name`);
    return (rows as unknown as { rows: ReportRow[] }).rows ?? [];
  }
}
