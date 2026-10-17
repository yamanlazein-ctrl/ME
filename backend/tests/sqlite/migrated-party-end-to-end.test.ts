/**
 * Migrated party end-to-end (SQLite / desktop engine).
 *
 * A customer or supplier moved from a legacy ERP has NO historical invoices, only an opening
 * balance. Scenario from the onboarding request:
 *
 *   Opening balance 100,000 owed to us                → statement starts at 100,000
 *   Payment/receipt voucher 20,000, no invoice        → remaining balance 80,000
 *   Cashbox                                           → moves by 20,000 in USD only
 *
 * Own temporary data root, SQLite only (same setup as tests/sqlite/party-opening.test.ts).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TenantContext } from "@/domain/types/index.js";

const root = mkdtempSync(join(tmpdir(), "motard-migrated-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

const DATE = "2026-09-20";

type Tx = typeof import("@/infrastructure/orm/sqlite/transaction.js");
let tx: Tx;
let parties: import("@/application/ports/IPartyRepository.js").IPartyRepository;
let vouchers: import("@/application/ports/IVoucherRepository.js").IVoucherRepository;
let ledger: import("@/application/ports/ILedgerRepository.js").ILedgerRepository;
let statements: import("@/application/ports/IStatementRepository.js").IStatementRepository;
let cashboxHelper: typeof import("@/infrastructure/repositories/sqlite/helpers/cashboxBalanceHelper.js");

/** Each scenario gets its own tenant: the cashbox is per tenant, so shared tenants would leak. */
async function freshTenant(): Promise<TenantContext> {
  const tenantId = randomUUID();
  await tx.runInTransaction(async (t) => {
    await t.execute(
      sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Migration E2E', ${`mig-${tenantId}`})`,
    );
  });
  return {
    tenantId,
    userId: randomUUID(),
    userRole: "admin",
    userName: "migration-e2e",
  } as TenantContext;
}

beforeAll(async () => {
  const runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  tx = await import("@/infrastructure/orm/sqlite/transaction.js");
  await runtime.ensureSqliteRuntime();
  const { SqlitePartyRepository } =
    await import("@/infrastructure/repositories/sqlite/SqlitePartyRepository.js");
  const { SqliteVoucherRepository } =
    await import("@/infrastructure/repositories/sqlite/SqliteVoucherRepository.js");
  const { SqliteLedgerRepository } =
    await import("@/infrastructure/repositories/sqlite/SqliteLedgerRepository.js");
  const { SqliteStatementRepository } =
    await import("@/infrastructure/repositories/sqlite/SqliteStatementRepository.js");
  cashboxHelper =
    await import("@/infrastructure/repositories/sqlite/helpers/cashboxBalanceHelper.js");
  const db = tx.sqliteDb() as never;
  parties = new SqlitePartyRepository(db);
  vouchers = new SqliteVoucherRepository(db);
  ledger = new SqliteLedgerRepository(db);
  statements = new SqliteStatementRepository(db);
});

async function migratedParty(kind: "customer" | "supplier", ctx: TenantContext) {
  return parties.create(
    {
      kind,
      // Names are unique per tenant; each kind gets its own party.
      name: kind === "supplier" ? "محمد — مورد مرحّل" : "محمد — عميل مرحّل",
      code: `MIG-${kind}`,
      currency: "USD",
      openingBalance: 100_000,
      openingCurrency: "USD",
      openingDate: DATE,
    },
    ctx,
  );
}

describe.each(["supplier", "customer"] as const)(
  "migrated %s: opening → voucher → cashbox",
  (kind) => {
    it("the opening is the statement baseline, the voucher settles it, the cashbox moves", async () => {
      const ctx = await freshTenant();
      const party = await migratedParty(kind, ctx);

      // 1. The opening balance is recognised: party balance and statement start at 100,000.
      expect((await ledger.getBalance(party.id, ctx, "USD")).balance).toBe(100_000);
      const opening = await statements.getStatement(
        { partyId: party.id, kind, currency: "USD" },
        ctx,
      );
      expect(opening.entries[0]?.type).toBe("opening");
      expect(opening.entries[0]?.runningBalance).toBe(100_000);
      expect(opening.finalBalance).toBe(100_000);

      // 2. A 20,000 voucher with NO invoice settles against the opening balance.
      const voucher = await vouchers.create(
        {
          kind: kind === "supplier" ? "payment" : "receipt",
          date: DATE,
          partyId: party.id,
          partyKind: kind,
          amount: 20_000,
          currency: "USD",
          exchangeRate: 1,
          method: "cash",
        },
        ctx,
      );
      expect(voucher.invoiceId).toBeUndefined();

      // 3. Remaining balance: 100,000 → 80,000, statement shows both lines.
      expect((await ledger.getBalance(party.id, ctx, "USD")).balance).toBe(80_000);
      const after = await statements.getStatement(
        { partyId: party.id, kind, currency: "USD" },
        ctx,
      );
      expect(after.entries.map((e) => e.runningBalance)).toEqual([100_000, 80_000]);
      expect(after.finalBalance).toBe(80_000);

      // 4. Cashbox moves by the voucher amount in USD, and nothing in SYP.
      await tx.runInTransaction(async (t) => {
        const expected = kind === "supplier" ? -20_000 : 20_000;
        expect(await cashboxHelper.getCashboxBalanceAsOf(t, ctx, "USD", DATE)).toBe(expected);
        expect(await cashboxHelper.recomputeCashboxBalanceAsOf(t, ctx, "USD", DATE)).toBe(expected);
        expect(await cashboxHelper.getCashboxBalanceAsOf(t, ctx, "SYP", DATE)).toBe(0);
      });
    });
  },
);
