/**
 * T044 (specs/001-desktop-sqlite-engine): SQLite constraint/type errors reach every consumer
 * in PostgreSQL's shape — SQLSTATE `code`, PG `constraint` name and PG message text — so the
 * user-facing text from persistenceErrorMessage is identical on both engines.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { bootSqlite, resolveSqliteMigrationsFolder } from "@/infrastructure/orm/sqlite/runtime.js";
import { closeSqlite, type SqliteConnections } from "@/infrastructure/orm/sqlite/connection.js";
import { withTenantTx, resetSqliteTransactionsForTests } from "@/infrastructure/orm/sqlite/transaction.js";
import { PgShapedError } from "@/infrastructure/orm/sqlite/errors.js";
import { persistenceErrorMessage } from "@/infrastructure/errors/persistenceErrorMessage.js";

let dir: string;
let conns: SqliteConnections;
const tenant = randomUUID();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "motard-err-"));
  conns = bootSqlite({ path: join(dir, "m.db"), migrationsDir: resolveSqliteMigrationsFolder(), startupState: "FRESH", installationId: "x" }).conns;
  await withTenantTx(tenant, async (tx) => tx.run(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenant}, 'T', 'slug-1')`));
});
afterEach(() => {
  closeSqlite(conns);
  resetSqliteTransactionsForTests();
  rmSync(dir, { recursive: true, force: true });
});

/** Run one statement in a transaction; return the PG-shaped error found in the cause chain. */
async function failing(q: SQL): Promise<{ pg: PgShapedError; raw: unknown }> {
  try {
    await withTenantTx(tenant, async (tx) => tx.run(q));
  } catch (e) {
    let cur: unknown = e;
    for (let i = 0; cur && i < 10; i++) {
      if (cur instanceof PgShapedError) return { pg: cur, raw: e };
      cur = (cur as { cause?: unknown }).cause;
    }
    throw new Error(`no PgShapedError in chain: ${String(e)}`);
  }
  throw new Error("statement unexpectedly succeeded");
}

describe("SQLite errors in PostgreSQL shape (T044)", () => {
  it("UNIQUE → 23505 with the PG constraint name", async () => {
    const { pg, raw } = await failing(sql`INSERT INTO tenants (id, name, slug) VALUES (${randomUUID()}, 'T2', 'slug-1')`);
    expect(pg).toMatchObject({ code: "23505", constraint: "tenants_slug_key" });
    expect(pg.message).toBe('duplicate key value violates unique constraint "tenants_slug_key"');
    expect(persistenceErrorMessage(raw, "generic")).toBe("تعذّر حفظ العملية بسبب تعارض في البيانات — أعد المحاولة.");
  });

  it("UNIQUE on parties(tenant_id, name) maps to the party-name message", async () => {
    await withTenantTx(tenant, async (tx) => tx.run(sql`INSERT INTO parties (id, tenant_id, kind, name) VALUES (${randomUUID()}, ${tenant}, 'customer', 'Ali')`));
    const { pg, raw } = await failing(sql`INSERT INTO parties (id, tenant_id, kind, name) VALUES (${randomUUID()}, ${tenant}, 'customer', 'Ali')`);
    expect(pg.constraint).toBe("parties_tenant_id_name_key");
    expect(persistenceErrorMessage(raw, "party")).toBe("اسم العميل/المورد مستخدم مسبقاً — اختر اسماً مختلفاً أو افتح السجل الموجود.");
  });

  it("FOREIGN KEY → 23503 naming the violated FK (probe), incl. the sync-device message", async () => {
    const { pg, raw } = await failing(sql`INSERT INTO sync_outbox (id, tenant_id, sync_device_id, op_id, entity_type, entity_id, operation, payload, seq)
      VALUES (${randomUUID()}, ${tenant}, ${randomUUID()}, ${randomUUID()}, 'invoice', ${randomUUID()}, 'create', '{}', 1)`);
    expect(pg).toMatchObject({ code: "23503", constraint: "sync_outbox_sync_device_id_fkey", table: "sync_outbox" });
    expect(pg.message).toBe('insert or update on table "sync_outbox" violates foreign key constraint "sync_outbox_sync_device_id_fkey"');
    expect(persistenceErrorMessage(raw, "invoice")).toBe("معرّف جهاز المزامنة غير مسجّل — أعد تسجيل الدخول أو أعد تفعيل الجهاز ثم حاول مجدداً.");
    // the probe left nothing behind
    expect(conns.reader.prepare("SELECT count(*) FROM sync_outbox").pluck().get()).toBe(0);
  });

  it("NOT NULL → 23502", async () => {
    const { pg, raw } = await failing(sql`INSERT INTO parties (id, tenant_id, kind, name) VALUES (${randomUUID()}, ${tenant}, 'customer', NULL)`);
    expect(pg).toMatchObject({ code: "23502", table: "parties", column: "name" });
    expect(pg.message).toBe('null value in column "name" of relation "parties" violates not-null constraint');
    expect(persistenceErrorMessage(raw, "party")).toBe("حقل إلزامي ناقص في بيانات الطرف — أكمل جميع الحقول المطلوبة.");
  });

  it("CHECK → 23514 with the PG constraint name", async () => {
    const { pg, raw } = await failing(sql`INSERT INTO ledger_entries (id, tenant_id, date, type, currency, cash_impact, debit, credit)
      VALUES (${randomUUID()}, ${tenant}, '2026-03-01', 'bogus', 'SYP', 'none', 100, 0)`);
    expect(pg).toMatchObject({ code: "23514", constraint: "ledger_entries_type_check" });
    expect(pg.message).toBe('new row for relation "ledger_entries" violates check constraint "ledger_entries_type_check"');
    expect(persistenceErrorMessage(raw, "invoice")).toBe("نوع الحركة المحاسبية غير مسموح به — راجع الإعدادات أو تواصل مع الدعم.");
  });

  it("varchar length → 22001; jsonb → 22P02; date → 22008 (PG type rejections)", async () => {
    const long = "x".repeat(256);
    const len = await failing(sql`INSERT INTO parties (id, tenant_id, kind, name) VALUES (${randomUUID()}, ${tenant}, 'customer', ${long})`);
    expect(len.pg).toMatchObject({ code: "22001", message: "value too long for type character varying(255)" });
    expect(persistenceErrorMessage(len.raw, "party")).toBe("أحد النصوص أطول من الحد المسموح — قصّر الملاحظات أو المرجع.");
    const json = await failing(sql`INSERT INTO sync_outbox (id, tenant_id, op_id, entity_type, entity_id, operation, payload, seq)
      VALUES (${randomUUID()}, ${tenant}, ${randomUUID()}, 'invoice', ${randomUUID()}, 'create', 'not json', 1)`);
    expect(json.pg.code).toBe("22P02");
    const date = await failing(sql`INSERT INTO ledger_entries (id, tenant_id, date, type, currency, cash_impact, debit, credit)
      VALUES (${randomUUID()}, ${tenant}, '2026-02-30', 'cash', 'SYP', 'none', 100, 0)`);
    expect(date.pg.code).toBe("22008");
  });

  it("STRICT type mismatch → 22P02 (the uuid/number syntax message)", async () => {
    const { pg, raw } = await failing(sql`INSERT INTO ledger_entries (id, tenant_id, date, type, currency, cash_impact, debit, credit)
      VALUES (${randomUUID()}, ${tenant}, '2026-03-01', 'cash', 'SYP', 'none', 'abc', 0)`);
    expect(pg.code).toBe("22P02");
    expect(persistenceErrorMessage(raw, "invoice")).toBe("أحد المعرّفات المرسلة غير صالح — أعد فتح الصفحة وحاول مجدداً.");
  });

  it("append-only guards → 42501 with the PG message text", async () => {
    const id = randomUUID();
    await withTenantTx(tenant, async (tx) =>
      tx.run(sql`INSERT INTO ledger_entries (id, tenant_id, date, type, currency, cash_impact, debit, credit) VALUES (${id}, ${tenant}, '2026-03-01', 'cash', 'SYP', 'none', 100, 0)`),
    );
    const { pg } = await failing(sql`DELETE FROM ledger_entries WHERE id = ${id}`);
    expect(pg).toMatchObject({ code: "42501", message: "ledger_entries is append-only: DELETE not allowed" });
  });
});
