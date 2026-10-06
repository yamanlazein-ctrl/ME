/**
 * Bug #8 — statement page clamping, against the REAL production code.
 *
 * The previous version of this file re-implemented `clampStatementPage` inside
 * the test body and asserted against that local copy, so it passed no matter
 * what the shipped repository did. These cases drive the two pieces of
 * production code that actually decide what the user sees:
 *
 *   1. `clampStatementPageIndex` — the client-side clamp the pager uses, so a
 *      stale page index can never render against a short statement.
 *   2. `PostgresStatementRepository.getStatement` — the live numbered-page
 *      path, which must report TRUTHFUL totals for the whole window and must
 *      never silently serve the last page under a page number that is past the
 *      end (that mislabels every row's `seq` and running balance).
 *
 * The repository half needs Postgres; it is a visible skip without a reachable
 * database (see _helpers/requireDatabase), never a silent pass.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresStatementRepository } from "@/infrastructure/repositories/PostgresStatementRepository.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";
import { clampStatementPageIndex } from "@erp/shared/statementPaging";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "stmt-clamp",
};

// Exactly the reported situation: a customer with FOUR invoices.
const ROW_COUNT = 4;

describe("statement page clamp (bug #8)", () => {
  describe("clampStatementPageIndex — the pager's production clamp", () => {
    it("4 rows / pageSize 20 → page 0 of 1, never page 100", () => {
      expect(clampStatementPageIndex(99, 1)).toBe(0);
      expect(clampStatementPageIndex(100, 1)).toBe(0);
    });

    it("0 rows still reports 1 total page and clamps to 0", () => {
      expect(clampStatementPageIndex(5, 1)).toBe(0);
    });

    it("25 rows / pageSize 10 → 3 pages; page 2 stays put", () => {
      expect(clampStatementPageIndex(2, 3)).toBe(2);
    });

    it("25 rows / pageSize 10 → a page past the end clamps to the last page", () => {
      expect(clampStatementPageIndex(99, 3)).toBe(2);
    });

    it("survives junk input without producing a negative or NaN page", () => {
      expect(clampStatementPageIndex(-5, 3)).toBe(0);
      expect(clampStatementPageIndex(Number.NaN, 3)).toBe(0);
      expect(clampStatementPageIndex(1.9, 3)).toBe(1);
      // totalPages unknown (first paint): fall back to a single page, never crash.
      expect(clampStatementPageIndex(0, undefined)).toBe(0);
    });
  });

  describe("PostgresStatementRepository — live numbered pages (4 invoices)", () => {
    let reachable = false;
    beforeAll(async () => {
      reachable = await databaseReachable();
      if (!reachable) return;
      await db.insert(tenants).values({
        id: tenantId,
        name: "Clamp Tenant",
        slug: `cl-${tenantId.slice(0, 8)}`,
      });
      await db.insert(parties).values({
        id: customerId,
        tenantId,
        name: "Four Invoice Customer",
        code: "CL-4",
        kind: "customer",
        currency: "SYP",
      });
      await db.insert(ledgerEntries).values(
        Array.from({ length: ROW_COUNT }, (_, i) => ({
          tenantId,
          partyId: customerId,
          date: `2026-01-0${i + 1}`,
          type: "sales_invoice" as const,
          debit: 100_000,
          credit: 0,
          currency: "SYP",
          referenceNumber: `INV-C-${i}`,
          status: "active" as const,
        })),
      );
    });

    it("page 0 returns all 4 invoices with truthful totals", async (t) => {
      skipUnlessDatabase(reachable, t.skip);
      const repo = new PostgresStatementRepository(db);
      const r = await repo.getStatement(
        { partyId: customerId, kind: "customer", currency: "SYP", limit: 20, page: 0 },
        ctx,
      );
      expect(r.entries).toHaveLength(ROW_COUNT);
      expect(r.page!.totalRows).toBe(ROW_COUNT);
      expect(r.page!.totalPages).toBe(1);
      // Nothing is hidden behind a cap: every invoice is present.
      expect(r.entries.map((e) => e.referenceNumber).sort()).toEqual([
        "INV-C-0",
        "INV-C-1",
        "INV-C-2",
        "INV-C-3",
      ]);
    });

    it("a stale page 100 yields NO rows but still reports 1 page / 4 records", async (t) => {
      skipUnlessDatabase(reachable, t.skip);
      const repo = new PostgresStatementRepository(db);
      const r = await repo.getStatement(
        { partyId: customerId, kind: "customer", currency: "SYP", limit: 20, page: 100 },
        ctx,
      );
      // The server must not silently serve the last page under page 100.
      expect(r.entries).toHaveLength(0);
      // …but the totals it reports are the truth for the window.
      expect(r.page!.totalPages).toBe(1);
      expect(r.page!.totalRows).toBe(ROW_COUNT);
      // Which is exactly what lets the client clamp to page 0.
      expect(clampStatementPageIndex(100, r.page!.totalPages)).toBe(0);
    });

    it("pageSize smaller than the record count paginates without losing a row", async (t) => {
      skipUnlessDatabase(reachable, t.skip);
      const repo = new PostgresStatementRepository(db);
      const q = { partyId: customerId, kind: "customer", currency: "SYP", limit: 3 } as const;
      const p1 = await repo.getStatement({ ...q, page: 0 }, ctx);
      const p2 = await repo.getStatement({ ...q, page: 1 }, ctx);
      expect(p1.entries).toHaveLength(3);
      expect(p2.entries).toHaveLength(1);
      expect(p1.page!.totalPages).toBe(2);
      expect(p1.page!.totalRows).toBe(4);
      // Disjoint pages, union is the whole statement, in order.
      const ids = [...p1.entries, ...p2.entries].map((e) => e.id);
      expect(new Set(ids).size).toBe(4);
      expect(p1.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(p2.entries.map((e) => e.seq)).toEqual([4]);
    });
  });
});
