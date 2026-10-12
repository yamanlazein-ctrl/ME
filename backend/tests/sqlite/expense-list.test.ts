/**
 * FE-03 / FE-04: the expenses list is server-paged (default 20) and must report the true total, the
 * date window must filter, and the global search must find an expense by its name (category) as well
 * as its number/description — that is what the operator types. Real SQLite file, own data root.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TenantContext } from "@/domain/types/index.js";

const root = mkdtempSync(join(tmpdir(), "motard-expense-list-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

const tenantId = randomUUID();
const ctx = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "tester",
} as TenantContext;
let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
let repo: import("@/infrastructure/repositories/sqlite/SqliteExpenseRepository.js").SqliteExpenseRepository;

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  const tx = await import("@/infrastructure/orm/sqlite/transaction.js");
  await runtime.ensureSqliteRuntime();
  await tx.runInTransaction(async (t) => {
    await t.execute(
      sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Expenses', 'expenses')`,
    );
    for (let i = 1; i <= 25; i++) {
      const day = String(i).padStart(2, "0");
      const category = i === 7 ? "كهرباء" : "إيجار";
      await t.execute(sql`
        INSERT INTO expenses (tenant_id, number, category, description, amount, currency, date, method)
        VALUES (${tenantId}, ${`EXP-${day}`}, ${category}, ${`دفعة ${day}`}, 1000, 'SYP', ${`2026-03-${day}`}, 'cash')`);
    }
  });
  const { SqliteExpenseRepository } =
    await import("@/infrastructure/repositories/sqlite/SqliteExpenseRepository.js");
  repo = new SqliteExpenseRepository(tx.sqliteDb() as never);
}, 60_000);

afterAll(() => {
  runtime?.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
});

describe("expense list (SQLite)", () => {
  it("pages at 20 but reports the true total and a next page", async () => {
    const p0 = await repo.list({}, ctx);
    expect(p0.data).toHaveLength(20);
    expect(p0.meta.total).toBe(25);
    expect(p0.meta.hasNext).toBe(true);
    const p1 = await repo.list({ page: 1 }, ctx);
    expect(p1.data).toHaveLength(5);
    expect(p1.meta.hasNext).toBe(false);
  });

  it("filters by the date window", async () => {
    const r = await repo.list({ fromDate: "2026-03-10", toDate: "2026-03-12" }, ctx);
    expect(r.data.map((e) => e.number).sort()).toEqual(["EXP-10", "EXP-11", "EXP-12"]);
  });

  it("search matches number, description and the expense name (category)", async () => {
    expect((await repo.list({ search: "EXP-03" }, ctx)).data.map((e) => e.number)).toEqual([
      "EXP-03",
    ]);
    expect((await repo.list({ search: "دفعة 04" }, ctx)).data.map((e) => e.number)).toEqual([
      "EXP-04",
    ]);
    expect((await repo.list({ search: "كهرباء" }, ctx)).data.map((e) => e.number)).toEqual([
      "EXP-07",
    ]);
  });
});
