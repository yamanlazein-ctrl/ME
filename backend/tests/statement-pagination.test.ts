/**
 * OLD-PLAN Phase 2 — statement pages are bounded; totals cover the full window.
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
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "stmt-page",
};

describe("statement pagination", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db.insert(tenants).values({
      id: tenantId,
      name: "Stmt Page Tenant",
      slug: `sp-${tenantId.slice(0, 8)}`,
    });
    await db.insert(parties).values({
      id: customerId,
      tenantId,
      name: "Page Customer",
      code: "PG-C",
      kind: "customer",
      currency: "SYP",
    });
    const rows = Array.from({ length: 25 }, (_, i) => ({
      tenantId,
      partyId: customerId,
      date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      type: "sales_invoice" as const,
      debit: 1000,
      credit: 0,
      currency: "SYP",
      referenceNumber: `INV-P-${i}`,
      status: "active" as const,
    }));
    await db.insert(ledgerEntries).values(rows);
  });

  it("returns a page with hasMore and full-window totals", async () => {
    const repo = new PostgresStatementRepository(db);
    const page1 = await repo.getStatement(
      { partyId: customerId, kind: "customer", currency: "SYP", limit: 10 },
      ctx,
    );
    expect(page1.entries).toHaveLength(10);
    expect(page1.page?.hasMore).toBe(true);
    expect(page1.page?.nextCursor).toBeTruthy();
    expect(page1.totalDebit).toBe(25_000);
    expect(page1.finalBalance).toBe(25_000);

    const page2 = await repo.getStatement(
      {
        partyId: customerId,
        kind: "customer",
        currency: "SYP",
        limit: 10,
        cursor: page1.page!.nextCursor!,
      },
      ctx,
    );
    expect(page2.entries).toHaveLength(10);
    expect(page2.totalDebit).toBe(25_000);
    expect(page2.entries[0]!.id).not.toBe(page1.entries[0]!.id);
  });

  it("walking every page returns every row exactly once (cursor keeps microseconds)", async () => {
    // All 25 rows share one created_at (single INSERT). A millisecond-truncated
    // cursor re-matched the boundary row, repeating it on the next page — the
    // 5-year audit found 11 duplicated lines in one customer's statement.
    const repo = new PostgresStatementRepository(db);
    const ids: string[] = [];
    let cursor: string | undefined;
    let running = 0;
    for (let guard = 0; guard < 20; guard++) {
      const page = await repo.getStatement(
        { partyId: customerId, kind: "customer", currency: "SYP", limit: 7, cursor },
        ctx,
      );
      ids.push(...page.entries.map((e) => e.id));
      running = page.entries.at(-1)?.runningBalance ?? running;
      if (!page.page?.hasMore) break;
      cursor = page.page.nextCursor!;
    }
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
    expect(running).toBe(25_000);
  });
});
