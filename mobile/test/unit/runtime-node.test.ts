import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { closeRuntime, ensureMeta, openRuntime, type PhoneRuntime } from "../../src/core/runtime";
import { diffSqliteFingerprint, readSqliteFingerprint } from "../../src/core/schemaFingerprint";
import { COMMITTED_FINGERPRINT, JOURNAL_LAST_IDX } from "../../src/core/generated/migrations";
import { openNodeShim } from "../helpers/nodeSqlite";
import { runInTransaction } from "@backend/infrastructure/orm/sqlite/transaction";
import { pgNumericDivide } from "@backend/infrastructure/repositories/sqlite/helpers/pgNumericDiv";
import { formatScaled } from "@backend/infrastructure/orm/sqlite/types";
import type { ShimDatabase } from "../../src/platform/sqlite/types";

const backendMigrations = path.resolve(
  __dirname,
  "../../../backend/src/infrastructure/orm/sqlite/migrations",
);

let dir = "";
let conn: ShimDatabase;
let runtime: PhoneRuntime;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "motard-mobile-runtime-"));
  conn = openNodeShim(path.join(dir, "motard.db"));
  runtime = openRuntime(conn);
});

afterAll(() => {
  closeRuntime(runtime);
  rmSync(dir, { recursive: true, force: true });
});

describe("phone runtime over Node SQLite (R2 criteria 2 and 4, NFR-06)", () => {
  it("applies every bundled migration and the live schema equals the committed fingerprint", () => {
    expect(runtime.appliedMigrations).toHaveLength(10);
    const committed = JSON.parse(
      readFileSync(path.join(backendMigrations, "meta", "schema-fingerprint.json"), "utf8"),
    );
    const live = readSqliteFingerprint(conn, JOURNAL_LAST_IDX);
    expect(diffSqliteFingerprint(committed, live)).toEqual([]);
    expect(diffSqliteFingerprint(COMMITTED_FINGERPRINT, live)).toEqual([]);
  });

  it("matches the backend's own fingerprint function", async () => {
    const backend = await import("@backend/infrastructure/orm/sqlite/schemaFingerprint");
    const theirs = backend.readSqliteFingerprint(conn as never, JOURNAL_LAST_IDX);
    expect(
      diffSqliteFingerprint(theirs as never, readSqliteFingerprint(conn, JOURNAL_LAST_IDX)),
    ).toEqual([]);
  });

  it("reopening applies nothing and ensureMeta creates the single meta row once", () => {
    const tenantId = randomUUID();
    ensureMeta(conn, { tenantId, installationId: "phone-install-1" });
    ensureMeta(conn, { tenantId: randomUUID(), installationId: "other" });
    const rows = conn.prepare("SELECT * FROM motard_meta").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 1,
      tenant_id: tenantId,
      created_by_installation_id: "phone-install-1",
      schema_journal_idx: JOURNAL_LAST_IDX,
    });
  });

  it("motard_pgdiv through the shim equals pgNumericDivide on 3,000 seeded quotients", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const mag = (k: number) => BigInt(Math.floor(rnd() * 10 ** (1 + Math.floor(rnd() * k))));
    const stmt = conn.prepare("SELECT motard_pgdiv(?, ?, ?, ?) AS q").safeIntegers(true);
    for (let i = 0; i < 3000; i++) {
      const sa = [2, 4, 6][i % 3] as number;
      const sb = [2, 2, 4][i % 3] as number;
      const a = mag(13) * (rnd() < 0.2 ? -1n : 1n);
      const b = mag(10) + 1n;
      const got = (stmt.get(a, sa, b, sb) as { q: string | null }).q;
      expect(got, `${formatScaled(a, sa)} / ${formatScaled(b, sb)}`).toBe(
        pgNumericDivide(a, sa, b, sb),
      );
    }
    expect((stmt.get(10n, 2, 0n, 2) as { q: unknown }).q).toBeNull();
    expect(
      (conn.prepare("SELECT motard_dectext(?, ?) AS t").get(12345n, 2) as { t: string }).t,
    ).toBe("123.45");
  });

  it("a use-case transaction that throws after inserting an invoice header leaves 0 rows (E6)", async () => {
    const tenantId = randomUUID();
    conn
      .prepare("INSERT INTO tenants (id, name, slug) VALUES (?, 'T', ?)")
      .run(tenantId, `t-${tenantId}`);
    const count = (table: string) =>
      (conn.prepare(`SELECT count(*) AS c FROM "${table}"`).get() as { c: number }).c;

    const invoiceId = randomUUID();
    const rows = [
      `INSERT INTO invoices (id, tenant_id, number, type, date, party_id, party_type) VALUES ('${invoiceId}', '${tenantId}', 'INV-2026-0001', 'sale', '2026-01-15', '${randomUUID()}', 'customer')`,
      `INSERT INTO invoice_lines (id, tenant_id, invoice_id, fabric_id, color_id, roll_id, quantity_kg, price_per_kg) VALUES ('${randomUUID()}', '${tenantId}', '${invoiceId}', '${randomUUID()}', '${randomUUID()}', '${randomUUID()}', 100, 100)`,
      `INSERT INTO ledger_entries (id, tenant_id, date, type, debit, credit) VALUES ('${randomUUID()}', '${tenantId}', '2026-01-15', 'sales_invoice', 100, 0)`,
    ];

    await expect(
      runInTransaction(async (tx) => {
        await tx.execute(sql.raw("PRAGMA defer_foreign_keys = ON"));
        for (const row of rows) await tx.execute(sql.raw(row));
        expect(count("invoices")).toBe(1); // visible inside the transaction
        throw new Error("use-case failed after the header");
      }),
    ).rejects.toThrow("use-case failed after the header");

    expect(count("invoices")).toBe(0);
    expect(count("invoice_lines")).toBe(0);
    expect(count("ledger_entries")).toBe(0);
  });
});
