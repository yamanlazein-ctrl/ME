/**
 * Party opening balance (docs/TASK_PLAN_OPENING_BALANCE_AND_PRINT.md §2): amount + direction →
 * signed SoT, the journal carries the entered currency/date/note, and an edit cancels the old
 * balanced journal (kept for audit) and posts a new one in one transaction — refused on a stale
 * version or a closed year without touching anything. Own temporary data root; runs on either suite.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TenantContext } from "@/domain/types/index.js";

const root = mkdtempSync(join(tmpdir(), "motard-opening-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

const tenantId = randomUUID();
const ctx = { tenantId, userId: randomUUID(), userRole: "admin", userName: "tester" } as TenantContext;
let tx: typeof import("@/infrastructure/orm/sqlite/transaction.js");
let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
let uc: typeof import("@/application/use-cases/parties/partyUseCases.js");
let repo: import("@/application/ports/IPartyRepository.js").IPartyRepository;

type Row = { type: string; debit: number; credit: number; currency: string; date: string; status: string; description: string };
const journal = async (partyId: string) =>
  (
    await tx.sqliteDb().execute(sql`
      SELECT type, CAST(debit AS REAL) / 100 AS debit, CAST(credit AS REAL) / 100 AS credit,
             currency, date, status, description
        FROM ledger_entries WHERE reference_type = 'opening' AND reference_id = ${partyId}
       ORDER BY created_at, type`)
  ).rows as Row[];
const active = async (id: string) => (await journal(id)).filter((r) => r.status === "active");
const balanced = (rows: Row[]) =>
  expect(rows.reduce((s, r) => s + r.debit, 0)).toBeCloseTo(rows.reduce((s, r) => s + r.credit, 0), 2);

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  tx = await import("@/infrastructure/orm/sqlite/transaction.js");
  await runtime.ensureSqliteRuntime();
  await tx.runInTransaction(async (t) => {
    await t.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Opening', 'opening')`);
  });
  uc = await import("@/application/use-cases/parties/partyUseCases.js");
  const { SqlitePartyRepository } = await import("@/infrastructure/repositories/sqlite/SqlitePartyRepository.js");
  repo = new SqlitePartyRepository(tx.sqliteDb() as never);
}, 60_000);

afterAll(() => {
  runtime?.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
});

async function createCustomer(extra: Record<string, unknown> = {}) {
  const r = await uc.createPartyUseCase(
    repo,
    { kind: "customer", name: `C-${randomUUID().slice(0, 8)}`, currency: "SYP", ...extra } as never,
    ctx,
  );
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

describe("party opening balance", () => {
  it("direction → signed amount (customer and supplier × له / لنا)", () => {
    expect(uc.signedOpeningBalance("customer", 100, "they_owe_us")).toBe(100);
    expect(uc.signedOpeningBalance("customer", 100, "we_owe_them")).toBe(-100);
    expect(uc.signedOpeningBalance("supplier", 100, "we_owe_them")).toBe(100);
    expect(uc.signedOpeningBalance("supplier", 100, "they_owe_us")).toBe(-100);
  });

  it("create posts a balanced journal in the entered currency, date and note", async () => {
    const p = await createCustomer({
      openingAmount: 250,
      openingDirection: "they_owe_us",
      openingCurrency: "USD",
      openingDate: "2026-01-15",
      openingNote: "رصيد من الدفتر القديم",
    });
    expect(p.openingBalance).toBe(250);
    expect(p.openingCurrency).toBe("USD");
    expect(p.openingDate).toBe("2026-01-15");
    expect(p.openingNote).toBe("رصيد من الدفتر القديم");
    const rows = await active(p.id);
    expect(rows).toHaveLength(2);
    balanced(rows);
    const leg = rows.find((r) => r.type === "opening")!;
    expect(leg).toMatchObject({ debit: 250, credit: 0, currency: "USD", date: "2026-01-15" });
    expect(leg.description).toBe("الرصيد الافتتاحي — رصيد من الدفتر القديم");
  });

  it("edit cancels the old journal, posts the new one, bumps the version and audits", async () => {
    const p = await createCustomer({ openingAmount: 100, openingDirection: "they_owe_us", openingDate: "2026-02-01" });
    const r = await uc.updatePartyUseCase(
      repo,
      p.id,
      { opening: { amount: 40, direction: "we_owe_them", currency: "USD", date: "2026-03-01", note: "تصحيح" } } as never,
      ctx,
      p.version,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.version).toBe(p.version + 1);
    expect(r.data.openingBalance).toBe(-40);
    expect(r.data.openingCurrency).toBe("USD");

    const all = await journal(p.id);
    expect(all.filter((x) => x.status === "cancelled")).toHaveLength(2);
    const now = all.filter((x) => x.status === "active");
    expect(now).toHaveLength(2);
    balanced(now);
    expect(now.find((x) => x.type === "opening")).toMatchObject({ debit: 0, credit: 40, currency: "USD", date: "2026-03-01" });

    const audit = (
      await tx.sqliteDb().execute(sql`SELECT action FROM audit_logs WHERE entity_id = ${p.id}`)
    ).rows as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toEqual(["set_opening"]);
  });

  it("edit to zero only cancels", async () => {
    const p = await createCustomer({ openingAmount: 70, openingDirection: "they_owe_us" });
    const r = await uc.updatePartyUseCase(
      repo,
      p.id,
      { opening: { amount: 0, direction: "they_owe_us", currency: "SYP", date: "2026-02-01" } } as never,
      ctx,
      p.version,
    );
    expect(r.ok).toBe(true);
    expect(await active(p.id)).toHaveLength(0);
    expect(await journal(p.id)).toHaveLength(2);
  });

  it("a stale version is refused and changes nothing", async () => {
    const p = await createCustomer({ openingAmount: 10, openingDirection: "they_owe_us" });
    const r = await uc.updatePartyUseCase(
      repo,
      p.id,
      { opening: { amount: 99, direction: "they_owe_us", currency: "SYP", date: "2026-02-01" } } as never,
      ctx,
      p.version + 5,
    );
    expect(r.ok).toBe(false);
    expect((await active(p.id)).find((x) => x.type === "opening")?.debit).toBe(10);
    expect((await repo.findById(p.id, ctx))?.version).toBe(p.version);
  });

  it("a closed year refuses both the new date and cancelling a journal dated in it", async () => {
    await tx.runInTransaction(async (t) => {
      await t.execute(sql`INSERT INTO financial_years (tenant_id, year, status, period_start, period_end)
                          VALUES (${tenantId}, 2024, 'closed', '2024-01-01', '2024-12-31')`);
    });
    const refusedCreate = await uc.createPartyUseCase(
      repo,
      { kind: "customer", name: "closed-year", openingAmount: 5, openingDirection: "they_owe_us", openingDate: "2024-06-01" } as never,
      ctx,
    );
    expect(refusedCreate.ok).toBe(false);

    const p = await createCustomer({ openingAmount: 30, openingDirection: "they_owe_us", openingDate: "2026-01-01" });
    const intoClosed = await uc.updatePartyUseCase(
      repo,
      p.id,
      { opening: { amount: 30, direction: "they_owe_us", currency: "SYP", date: "2024-05-05" } } as never,
      ctx,
      p.version,
    );
    expect(intoClosed.ok).toBe(false);
    expect(await journal(p.id)).toHaveLength(2);
    expect((await repo.findById(p.id, ctx))?.version).toBe(p.version);
  });
});
