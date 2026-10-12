/**
 * Exporter tests on a real temp SQLite DB: seeded invoices/expenses across a
 * month boundary, totals re-summable from emitted rows, cancelled handling,
 * BOM presence, and month-boundary filtering by business date.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "motard-exp-")), "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

let raw: import("better-sqlite3").Database;
let Exporters: typeof import("../src/infrastructure/googledrive/exporters.js").Exporters;
let tenantId: string;
let customerId: string;

beforeAll(async () => {
  await import("../src/infrastructure/orm/sqlite/runtime.js").then((m) =>
    m.ensureSqliteRuntime({}),
  );
  const rt = (await import("../src/infrastructure/orm/sqlite/runtime.js")).getSqliteRuntime()!;
  raw = rt.conns.writer;
  (globalThis as Record<string, unknown>).__writerDb = rt.conns.writerDb;
  ({ Exporters } = await import("../src/infrastructure/googledrive/exporters.js"));
  tenantId = randomUUID();
  raw
    .prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'شركة التصدير', 'exp-test')`)
    .run(tenantId);
  customerId = randomUUID();
  raw
    .prepare(
      `INSERT INTO parties (id, tenant_id, kind, name, currency) VALUES (?, ?, 'customer', 'مؤسسة الفاتورة', 'SYP')`,
    )
    .run(customerId, tenantId);
  // Two sale invoices in 2026-10, one in 2026-09, one cancelled in 2026-10.
  const stmt = raw.prepare(
    `INSERT INTO invoices (id, tenant_id, number, type, date, party_id, party_type, subtotal, total, paid, status)
     VALUES (?, ?, ?, 'sale', ?, ?, 'customer', 100000, 100000, 50000, ?)`,
  );
  stmt.run(randomUUID(), tenantId, "INV-1001", "2026-10-05", customerId, "active");
  stmt.run(randomUUID(), tenantId, "INV-1002", "2026-10-20", customerId, "active");
  stmt.run(randomUUID(), tenantId, "INV-0909", "2026-09-28", customerId, "active");
  stmt.run(randomUUID(), tenantId, "INV-1003", "2026-10-25", customerId, "cancelled");
  const expense = raw.prepare(
    `INSERT INTO expenses (id, tenant_id, number, category, description, amount, date, method)
     VALUES (?, ?, ?, 'rent', 'إيجار', 25000, ?, 'cash')`,
  );
  expense.run(randomUUID(), tenantId, "EXP-1", "2026-10-10");
  expense.run(randomUUID(), tenantId, "EXP-2", "2026-09-10");
});

function decode(u8: Uint8Array): string {
  return new TextDecoder().decode(u8);
}

describe("exporters", () => {
  it("exports only the period's sale invoices, by business date", async () => {
    const exporters = new Exporters((globalThis as Record<string, unknown>).__writerDb as never);
    const rows = await exporters.invoicesForPeriod("2026-10", "sale");
    expect(rows).toHaveLength(3); // 1001, 1002, 1003(cancelled)
    const numbers = rows.map((r) => decode(r.content)).join();
    expect(numbers).toContain("INV-1001");
    expect(numbers).toContain("INV-1002");
    expect(numbers).not.toContain("INV-0909");
  });

  it("marks cancelled invoices without dropping them", async () => {
    const exporters = new Exporters((globalThis as Record<string, unknown>).__writerDb as never);
    const rows = await exporters.invoicesForPeriod("2026-10", "sale");
    const cancelled = rows.find((r) => r.fileName.includes("_ملغاة"));
    expect(cancelled).toBeTruthy();
    expect(decode(cancelled!.content)).toContain("ملغاة");
    expect(decode(cancelled!.content)).toContain("INV-1003");
  });

  it("deterministic sortable filenames carry date, number, and party name", async () => {
    const exporters = new Exporters((globalThis as Record<string, unknown>).__writerDb as never);
    const rows = await exporters.invoicesForPeriod("2026-10", "sale");
    for (const r of rows) {
      expect(r.fileName).toMatch(/^2026-10-\d{2}_INV-\d{4}_مؤسسة الفاتورة/);
    }
    const sorted = rows.map((r) => r.fileName).sort();
    expect(sorted[0]).toContain("2026-10-05");
  });

  it("crosses the month boundary correctly", async () => {
    const exporters = new Exporters((globalThis as Record<string, unknown>).__writerDb as never);
    const sept = await exporters.invoicesForPeriod("2026-09", "sale");
    expect(sept).toHaveLength(1);
    expect(decode(sept[0].content)).toContain("INV-0909");
  });

  it("CSV has a UTF-8 BOM and re-summable totals", async () => {
    const exporters = new Exporters((globalThis as Record<string, unknown>).__writerDb as never);
    const rows = await exporters.invoicesForPeriod("2026-10", "sale");
    const bytes = rows[0].content;
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    // Totals: each invoice row carries its own total — re-sum == source total.
    const totals = rows.map((r) => Number(decode(r.content).split("\r\n")[1].split(",")[3]));
    expect(totals.reduce((a, b) => a + b, 0)).toBe(3000); // 1000+1000+1000 (cancelled included)
  });

  it("expenses export as one monthly CSV with all in-period rows", async () => {
    const exporters = new Exporters((globalThis as Record<string, unknown>).__writerDb as never);
    const rows = await exporters.expensesForPeriod("2026-10");
    expect(rows).toHaveLength(1);
    const text = decode(rows[0].content);
    expect(text).toContain("EXP-1");
    expect(text).not.toContain("EXP-2");
    expect(rows[0].rowCount).toBe(1);
  });

  it("returns no rows for empty months (no invented content)", async () => {
    const exporters = new Exporters((globalThis as Record<string, unknown>).__writerDb as never);
    const rows = await exporters.invoicesForPeriod("2030-05", "sale");
    expect(rows).toEqual([]);
  });
});
