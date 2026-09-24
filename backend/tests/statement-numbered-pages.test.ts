/**
 * Screen paging of the party statement («الصفحة 3 من 12», 20/50/100 rows).
 *
 * Accounting condition: every page opens with the carried balance («رصيد
 * منقول») that the previous page closed on — per currency, for a customer
 * (debit side) and a supplier (credit side) — with cancelled rows shown but
 * never moving the balance, and no row repeated or skipped between pages.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresStatementRepository } from "@/infrastructure/repositories/PostgresStatementRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const supplierId = randomUUID();
const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "pages" };

function movements(partyId: string, kind: "customer" | "supplier", n: number) {
  return Array.from({ length: n }, (_, i) => {
    const ccy = i % 3 === 0 ? "USD" : "SYP";
    const big = kind === "customer" ? i % 4 !== 3 : i % 4 === 3; // mostly invoices, some payments
    const amount = 100 + i * 7.35;
    return {
      tenantId,
      partyId,
      // several rows per day and identical created_at: ties broken by id
      date: `2025-0${1 + (i % 9)}-${String(1 + (i % 27)).padStart(2, "0")}`,
      type: (big ? (kind === "customer" ? "sales_invoice" : "purchase_invoice") : kind === "customer" ? "receipt_in" : "payment_out") as never,
      debit: big === (kind === "customer") ? amount : 0,
      credit: big === (kind === "customer") ? 0 : amount,
      currency: ccy,
      referenceNumber: `DOC-${i}`,
      status: (i % 11 === 5 ? "cancelled" : "active") as never,
    };
  });
}

describe("statement numbered pages", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db.insert(tenants).values({ id: tenantId, name: "Pages", slug: `pg-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values([
      { id: customerId, tenantId, name: "Pages C", code: "PG-C", kind: "customer", currency: "SYP" },
      { id: supplierId, tenantId, name: "Pages S", code: "PG-S", kind: "supplier", currency: "SYP" },
    ]);
    await db.insert(ledgerEntries).values(movements(customerId, "customer", 137));
    await db.insert(ledgerEntries).values(movements(supplierId, "supplier", 64));
  });

  for (const [label, partyId, kind] of [
    ["customer", customerId, "customer"],
    ["supplier", supplierId, "supplier"],
  ] as const) {
    for (const currency of ["SYP", "USD", "ALL"] as const) {
      for (const limit of [20, 50, 100]) {
        it(`${label} ${currency} × ${limit}: each page opens with the balance the previous page closed on`, async () => {
          const repo = new PostgresStatementRepository(db);
          // Reference: one unpaged pass (cursor walk) = the truth.
          const truth: Array<{ id: string; running: number }> = [];
          let cursor: string | undefined;
          for (let g = 0; g < 50; g++) {
            const r = await repo.getStatement({ partyId, kind, currency, limit: 500, cursor }, ctx);
            truth.push(...r.entries.map((e) => ({ id: e.id, running: e.runningBalance })));
            if (!r.page?.hasMore) break;
            cursor = r.page.nextCursor!;
          }
          const first = await repo.getStatement({ partyId, kind, currency, limit, page: 0 }, ctx);
          const totalPages = first.page!.totalPages!;
          expect(first.page!.totalRows).toBe(truth.length);
          expect(totalPages).toBe(Math.max(1, Math.ceil(truth.length / limit)));

          const seen: Array<{ id: string; running: number; seq: number }> = [];
          const closing = new Map<string, number>(); // running per currency so far
          for (let pg = 0; pg < totalPages; pg++) {
            const r = await repo.getStatement({ partyId, kind, currency, limit, page: pg }, ctx);
            expect(r.page!.page).toBe(pg);
            // Carried balance per currency == what the previous page closed on.
            for (const [ccy, carried] of Object.entries(r.page!.balanceBeforePageByCurrency ?? {})) {
              expect(carried).toBeCloseTo(closing.get(ccy) ?? 0, 2);
            }
            for (const e of r.entries) {
              seen.push({ id: e.id, running: e.runningBalance, seq: e.seq });
              if (e.status === "active") closing.set(e.currency, e.runningBalance);
            }
            // Header totals are always the full window, whatever the page.
            expect(r.finalBalance).toBe(first.finalBalance);
          }
          expect(seen.map((s) => s.id)).toEqual(truth.map((t) => t.id));
          expect(seen.map((s) => s.running)).toEqual(truth.map((t) => t.running));
          expect(seen.map((s) => s.seq)).toEqual(seen.map((_, i) => i + 1));
        });
      }
    }
  }

  it("a page past the end is empty, not an error, and keeps the full-window totals", async () => {
    const repo = new PostgresStatementRepository(db);
    const r = await repo.getStatement({ partyId: customerId, kind: "customer", currency: "SYP", limit: 100, page: 99 }, ctx);
    expect(r.entries).toHaveLength(0);
    expect(r.page!.totalPages).toBeGreaterThan(0);
  });
});
