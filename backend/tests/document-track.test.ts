/**
 * Invoice-tracking feed (GET /api/documents/track) — server-paged merge of
 * invoices, returns, print jobs and settlement batches.
 *
 * Replaces a screen that downloaded every return/print job/voucher and
 * appended ALL of them under each page of invoices.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { rolls } from "@/infrastructure/orm/schemas/roll.table.js";
import { PostgresDocumentTrackRepository } from "@/infrastructure/repositories/PostgresDocumentTrackRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const cust = randomUUID();
const other = randomUUID();
const supp = randomUUID();
const fab = randomUUID();
const col = randomUUID();
const roll = randomUUID();
const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "track" };
const repo = new PostgresDocumentTrackRepository(db);

describe("document tracking feed", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db.insert(tenants).values({ id: tenantId, name: "Track", slug: `tr-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values([
      { id: cust, tenantId, name: "Track Customer", code: "TR-C", kind: "customer", currency: "USD" },
      { id: other, tenantId, name: "Other Customer", code: "TR-O", kind: "customer", currency: "USD" },
      { id: supp, tenantId, name: "Track Supplier", code: "TR-S", kind: "supplier", currency: "USD" },
    ]);
    // 30 sales for `cust` over 2022..2026, 5 for `other`, 3 purchases
    const inv = (n: number, type: string, party: string, date: string, status = "active") =>
      pool.query(
        `INSERT INTO invoices (id, tenant_id, number, type, date, party_id, party_type, currency, subtotal, total, paid, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'USD', 10, 10, 0, $8)`,
        [randomUUID(), tenantId, `TR-${type}-${n}`, type, date, party, type === "sale" ? "customer" : "supplier", status],
      );
    for (let i = 0; i < 30; i++) await inv(i, "sale", cust, `20${22 + (i % 5)}-0${1 + (i % 9)}-1${i % 9}`);
    for (let i = 0; i < 5; i++) await inv(100 + i, "sale", other, `2023-03-0${1 + i}`);
    for (let i = 0; i < 3; i++) await inv(200 + i, "entry", supp, `2021-12-0${1 + i}`);
    await inv(300, "sale", cust, "2020-01-01", "cancelled");
    // 2 returns for cust
    for (let i = 0; i < 2; i++)
      await pool.query(
        `INSERT INTO returns (id, tenant_id, number, kind, date, party_id, reason, currency, status)
         VALUES ($1, $2, $3, 'sale', $4, $5, 'defect', 'USD', 'active')`,
        [randomUUID(), tenantId, `TR-RET-${i}`, `2024-06-0${1 + i}`, cust],
      );
    // 1 print job (no party)
    await db.insert(fabrics).values({ id: fab, tenantId, name: "TR fabric" } as never);
    await db.insert(colors).values({ id: col, tenantId, fabricId: fab, name: "TR color" } as never);
    await db.insert(rolls).values({
      id: roll, tenantId, colorId: col, rollNo: `TR-${tenantId.slice(0, 6)}`, initialKg: "50",
      remainingKg: "37.5", pricePerKg: "2", currency: "USD", entryDate: "2024-12-01", pieces: 1, remainingPieces: 1,
    } as never);
    await pool.query(
      `INSERT INTO print_jobs (id, tenant_id, date, number, status, source_roll_id, quantity_kg, press_name, currency)
       VALUES ($1, $2, '2025-01-01', 'TR-PRN-1', 'sent', $3, 12.5, 'Press A', 'USD')`,
      [randomUUID(), tenantId, roll],
    );
    // one settlement batch = 3 vouchers carrying SET-2025-0007, one of them cancelled
    for (let i = 0; i < 3; i++)
      await pool.query(
        `INSERT INTO vouchers (tenant_id, kind, number, date, party_id, party_kind, amount, currency, method, status, notes_internal)
         VALUES ($1, 'receipt', $2, '2025-02-0${1 + i}', $3, 'customer', 10, 'USD', 'cash', $4, 'دفعة SET-2025-0007')`,
        [tenantId, `TR-V-${i}`, cust, i === 2 ? "cancelled" : "active"],
      );
    // an ordinary receipt (no batch) must NOT appear
    await pool.query(
      `INSERT INTO vouchers (tenant_id, kind, number, date, party_id, party_kind, amount, currency, method, status)
       VALUES ($1, 'receipt', 'TR-V-plain', '2025-03-01', $2, 'customer', 7, 'USD', 'cash', 'active')`,
      [tenantId, cust],
    );
  });

  it("lists every document type once, newest document date first, with an exact total", async () => {
    const p = await repo.list({ type: "all", page: 0, limit: 10 }, ctx);
    // 39 invoices (incl. 1 cancelled) + 2 returns + 1 print job + 1 settlement batch
    expect(p.total).toBe(43);
    expect(p.data).toHaveLength(10);
    const dates = p.data.map((r) => r.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("walking all pages returns every document exactly once", async () => {
    const seen = new Set<string>();
    for (let page = 0; ; page++) {
      const p = await repo.list({ type: "all", page, limit: 7 }, ctx);
      for (const r of p.data) seen.add(`${r.kind}:${r.id}`);
      if (!p.hasNext) break;
    }
    expect(seen.size).toBe(43);
  });

  it("groups a settlement batch into one row with the live total", async () => {
    const p = await repo.list({ type: "settlement" }, ctx);
    expect(p.total).toBe(1);
    expect(p.data[0]).toMatchObject({ number: "SET-2025-0007", status: "active", total: 20, partyId: cust });
  });

  it("applies party / date / status / search filters on the server", async () => {
    expect((await repo.list({ partyId: cust }, ctx)).total).toBe(31 + 2 + 1); // incl. cancelled invoice
    expect((await repo.list({ partyId: cust, status: "active" }, ctx)).total).toBe(30 + 2 + 1);
    expect((await repo.list({ type: "sale", fromDate: "2023-03-01", toDate: "2023-03-31" }, ctx)).total).toBe(
      5 + (await pool.query(
        `SELECT count(*)::int n FROM invoices WHERE tenant_id=$1 AND party_id=$2 AND date BETWEEN '2023-03-01' AND '2023-03-31'`,
        [tenantId, cust],
      )).rows[0].n,
    );
    const s = await repo.list({ search: "Other Customer" }, ctx);
    expect(s.total).toBe(5);
    expect((await repo.list({ search: "TR-sale-7" }, ctx)).data.map((r) => r.number)).toContain("TR-sale-7");
  });

  it("print jobs have no party: a party filter excludes them", async () => {
    expect((await repo.list({ type: "print_send" }, ctx)).total).toBe(1);
    expect((await repo.list({ type: "print_send", partyId: cust }, ctx)).total).toBe(0);
  });
});
