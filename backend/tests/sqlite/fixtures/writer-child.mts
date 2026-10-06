/**
 * Child process for the force-kill durability test (tests/sqlite/connection.test.ts, T047).
 * Boots a FRESH database at argv[2], then commits rows forever, printing each id only after
 * its COMMIT returned. The parent kills this process (taskkill /F) mid-loop and checks that
 * every printed id survived and the file passes integrity_check.
 */
import { randomUUID } from "node:crypto";
import { bootSqlite, resolveSqliteMigrationsFolder } from "../../../src/infrastructure/orm/sqlite/runtime.js";
import { withTenantTx } from "../../../src/infrastructure/orm/sqlite/transaction.js";

const path = process.argv[2];
const tenant = randomUUID();
const r = bootSqlite({ path, migrationsDir: resolveSqliteMigrationsFolder(), startupState: "FRESH", installationId: "kill-test" });
r.conns.writer.prepare("INSERT INTO tenants (id, name, slug) VALUES (?, 'kill', 'kill')").run(tenant);
process.stdout.write("READY\n");
for (let i = 0; ; i++) {
  const id = randomUUID();
  await withTenantTx(tenant, async (tx) => {
    tx.run(
      // a realistic multi-row write: ledger row + its cash-box trigger work
      (await import("drizzle-orm")).sql`INSERT INTO ledger_entries (id, tenant_id, date, type, currency, cash_impact, debit, credit)
        VALUES (${id}, ${tenant}, '2026-03-01', 'cash', 'SYP', 'in', ${100 + i}, 0)`,
    );
  });
  process.stdout.write(`${id}\n`);
}
