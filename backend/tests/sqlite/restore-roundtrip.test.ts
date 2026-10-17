/**
 * End-to-end backup → restore roundtrip (SQLite / desktop engine).
 *
 * Mimics the exact desktop restore flow:
 *   1. Seed real business data (parties with opening balances, invoices, ledger entries).
 *   2. Create a real v3 `.zip` backup via `createAndVerifyBackup`.
 *   3. Restore through the desktop hand-off: POST /api/backup/restore-path?confirm=replace
 *      with the shell's path + sha256 + sizeBytes (exactly what `pickBackupFile` + `FullRestoreCard`
 *      send over the text-only Tauri IPC bridge).
 *   4. Assert no "ملف غير صالح" / validation error, and that every seeded record is readable
 *      post-restore with correct balances.
 *
 * `ledger_entries` is append-only (trigger-guarded), so "wiping to zero" means cancelling
 * ledger entries and deleting invoices/parties — but since `restoreBackupV3` swaps the entire
 * database file atomically, the restore result is identical to a wipe-then-restore. The test
 * restores over live data (confirm=replace) to prove the swap works on a populated database.
 *
 * The live database file is swapped atomically (connections closed, rename, reopen) inside
 * `restoreBackupV3`; this test also verifies the runtime stays open and reachable after the swap.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, copyFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { sql } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "motard-rrt-"));
const saved = { ...process.env };
process.env.DB_ENGINE = "sqlite";
process.env.DESKTOP_DEPLOY = "true";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";
process.env.DATA_INTEGRITY_PATH = join(root, "state", "data-integrity.json");
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

const TENANT = randomUUID();
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

let server: Server;
let base = "";
let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");

/** The live writer connection (re-validated after the restore swap). */
function writer() {
  return runtime.getSqliteRuntime()!.conns.writer as unknown as import("better-sqlite3").Database;
}

async function txCount(table: string): Promise<number> {
  const r = writer().prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number };
  return Number(r.n);
}

async function seedPartyRows(): Promise<
  Array<{ id: string; name: string; code: string; kind: string; opening_balance: number }>
> {
  return writer()
    .prepare(
      "SELECT id, name, code, kind, opening_balance FROM parties WHERE tenant_id = ? ORDER BY code",
    )
    .all(TENANT) as Array<{
    id: string;
    name: string;
    code: string;
    kind: string;
    opening_balance: number;
  }>;
}

async function seedInvoiceRows(): Promise<Array<{ number: string; type: string; total: number }>> {
  return writer()
    .prepare("SELECT number, type, total FROM invoices WHERE tenant_id = ? ORDER BY number")
    .all(TENANT) as Array<{ number: string; type: string; total: number }>;
}

async function partyBalances(): Promise<number[]> {
  const stmt = writer().prepare(
    "SELECT coalesce(party_id, '-') AS party_id, currency, sum(debit) - sum(credit) AS balance FROM ledger_entries WHERE status = 'active' GROUP BY party_id, currency",
  );
  const rows = stmt.all() as Array<{ balance: number }>;
  return rows.map((r) => r.balance).sort((a, b) => a - b);
}

function liveFileImage(): string {
  return ["", "-wal", "-shm"]
    .map((x) => `${process.env.SQLITE_PATH}${x}`)
    .filter(existsSync)
    .sort()
    .map((p) => sha(readFileSync(p)))
    .join("|");
}

async function verifyPath(
  path: string,
  extra: { sha256?: string | null; sizeBytes?: number } = {},
) {
  if (extra.sha256 === undefined && existsSync(path))
    extra = { ...extra, sha256: sha(readFileSync(path)) };
  const r = await fetch(`${base}/api/backup/verify-path`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, ...extra }),
  });
  return {
    status: r.status,
    body: (await r.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
      ok?: boolean;
      formatVersion?: number;
      company?: string;
      rows?: number;
    },
  };
}

async function restorePath(
  path: string,
  extra: { sha256?: string | null; sizeBytes?: number } = {},
) {
  if (extra.sha256 === undefined && existsSync(path))
    extra = { ...extra, sha256: sha(readFileSync(path)) };
  const r = await fetch(`${base}/api/backup/restore-path?confirm=replace`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify({ path, ...extra }),
  });
  return {
    status: r.status,
    body: (await r.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
      tables?: Array<{ table: string; rows: number }>;
      restoredRows?: number;
    },
  };
}

let archive = "";

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  await runtime.ensureSqliteRuntime();
  const w = writer();

  // ── Seed a tenant ──
  await w
    .prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'شركة الجولة', 'rrt')`)
    .run(TENANT);

  // ── Seed parties (customers + supplier, with opening balances) ──
  const partyIds: string[] = [];
  const partyData = [
    ["customer", "عميل اختبار أول", "C-001", 5000],
    ["customer", "عميل اختبار ثانٍ", "C-002", 3000],
    ["supplier", "مورد اختبار أول", "S-001", -2000],
  ] as const;
  for (const [kind, name, code, balance] of partyData) {
    const id = randomUUID();
    partyIds.push(id);
    await w
      .prepare(
        `INSERT INTO parties (id, tenant_id, kind, code, name, currency, opening_balance, opening_date, status)
       VALUES (?, ?, ?, ?, ?, 'SYP', ?, '2026-09-01', 'active')`,
      )
      .run(id, TENANT, kind, code, name, balance);
  }

  // ── Seed invoices ──
  for (const [type, number, partyId, total] of [
    ["sale", "INV-2026-001", partyIds[0], 1000],
    ["sale", "INV-2026-002", partyIds[1], 500],
    ["entry", "INV-2026-003", partyIds[2], 800],
  ]) {
    await w
      .prepare(
        `INSERT INTO invoices (id, tenant_id, number, type, date, party_id, party_type, currency, subtotal, discount, tax, total, status)
       VALUES (?, ?, ?, ?, '2026-09-15', ?, ?, 'SYP', ?, 0, 0, ?, 'active')`,
      )
      .run(
        randomUUID(),
        TENANT,
        number,
        type,
        partyId,
        type === "entry" ? "supplier" : "customer",
        total,
        total,
      );
  }

  // ── Seed ledger entries (opening balances per party) ──
  for (const i in partyIds) {
    const openingBalance = [5000, 3000, -2000][Number(i)];
    const debit = openingBalance > 0 ? openingBalance : 0;
    const credit = openingBalance < 0 ? -openingBalance : 0;
    await w
      .prepare(
        `INSERT INTO ledger_entries (id, tenant_id, party_id, date, type, debit, credit, currency, status)
       VALUES (?, ?, ?, '2026-09-01', 'opening', ?, ?, 'SYP', 'active')`,
      )
      .run(randomUUID(), TENANT, partyIds[i], debit, credit);
  }

  // ── Create a REAL v3 .zip backup (the "operator's archive") ──
  const { createAndVerifyBackup } = await import("@/infrastructure/backup/sqliteBackup.js");
  const created = await createAndVerifyBackup({ kind: "manual", appVersion: "2.0.4" });
  const backupDir = join(root, "backups");
  copyFileSync(created.path, join(backupDir, "roundtrip-test.zip"));
  archive = join(backupDir, "roundtrip-test.zip");

  // ── Set up the Express app with the backup router (same as desktop) ──
  const { createBackupRouter } = await import("@/presentation/routes/backup.route.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tenantContext: unknown }).tenantContext = {
      tenantId: TENANT,
      userRole: "admin",
      userId: randomUUID(),
    };
    next();
  });
  app.use("/api", createBackupRouter({} as never));
  server = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  const rt = runtime.getSqliteRuntime();
  if (rt) (await import("@/infrastructure/orm/sqlite/connection.js")).closeSqlite(rt.conns);
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});

describe("full backup → restore roundtrip (desktop hand-off)", () => {
  it("the seeded data exists before the restore", async () => {
    expect(await txCount("parties")).toBe(3);
    expect(await txCount("invoices")).toBe(3);
    expect(await txCount("ledger_entries")).toBe(3);

    const ps = await seedPartyRows();
    expect(ps.map((p) => p.name)).toEqual([
      "عميل اختبار أول",
      "عميل اختبار ثانٍ",
      "مورد اختبار أول",
    ]);
    expect(ps.map((p) => p.opening_balance)).toEqual([5000, 3000, -2000]);

    const bal = await partyBalances();
    expect(bal).toEqual([-2000, 3000, 5000]);
  });

  it("the archive is a valid v3 zip at its root", async () => {
    const { unzipSync, strFromU8 } = await import("fflate");
    const e = unzipSync(new Uint8Array(readFileSync(archive)));
    expect(Object.keys(e).sort()).toEqual(["database.sqlite", "manifest.json", "manifest.sha256"]);
    const man = JSON.parse(strFromU8(e["manifest.json"])) as {
      format: string;
      formatVersion: number;
    };
    expect(man.format).toBe("motard-erp-backup");
    expect(man.formatVersion).toBe(3);
  });

  it("the archive verifies through /api/backup/verify-path (desktop hand-off)", async () => {
    const r = await verifyPath(archive);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.formatVersion).toBe(3);
    expect(r.body.company).toBe("شركة الجولة");
    expect(typeof r.body.rows).toBe("number");
    expect(r.body.rows).toBeGreaterThan(0);
  });

  it("rejects a wrong sha256 — never 'ملف غير صالح'", async () => {
    const r = await verifyPath(archive, { sha256: sha("a different file") });
    expect(r.status).not.toBe(200);
    expect(r.body.code).toBe("BACKUP_FILE_HASH_MISMATCH");
    expect(r.body.message).not.toBe("ملف غير صالح");
  });

  it("zeroes out business records (cancel ledger entries, delete invoices + parties)", async () => {
    const w = writer();
    w.exec("BEGIN");
    try {
      w.prepare("UPDATE ledger_entries SET status = 'cancelled', party_id = NULL").run();
      w.prepare("DELETE FROM invoices WHERE tenant_id = ?").run(TENANT);
      w.prepare("DELETE FROM parties WHERE tenant_id = ?").run(TENANT);
      w.exec("COMMIT");
    } catch (e) {
      w.exec("ROLLBACK");
      throw e;
    }

    expect(await txCount("parties")).toBe(0);
    expect(await txCount("invoices")).toBe(0);
    // Cancelled ledger entries still exist as rows but are inactive
    const active = (await txCount("ledger_entries")) - 0;
    const cancelled = writer()
      .prepare("SELECT count(*) AS n FROM ledger_entries WHERE status = 'cancelled'")
      .get() as { n: number };
    expect(Number(cancelled.n)).toBe(3);
  });

  it("restores the archive via /api/backup/restore-path?confirm=replace with no validation error", async () => {
    const archiveBefore = sha(readFileSync(archive));
    const r = await restorePath(archive, {
      sha256: sha(readFileSync(archive)),
      sizeBytes: statSync(archive).size,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // (a) No "ملف غير صالح" or generic validation failure
    expect(r.body.code).not.toBe("BACKUP_CORRUPT");
    if (typeof r.body.message === "string") {
      expect(r.body.message).not.toBe("ملف غير صالح");
      expect(r.body.message).not.toMatch(/غير صالح/);
    }
    // The operator's archive is only ever read (never modified)
    expect(sha(readFileSync(archive))).toBe(archiveBefore);
    // Runtime still open after the swap
    expect(runtime.getSqliteRuntime()).toBeTruthy();
    // Restored row counts reported by the server
    expect(r.body.restoredRows).toBeGreaterThan(0);
    expect(r.body.restoredRows).toBe(r.body.tables!.reduce((a, t) => a + t.rows, 0));
  }, 180_000);

  it("the database is fully repopulated with the original records", async () => {
    expect(await txCount("parties")).toBe(3);
    expect(await txCount("invoices")).toBe(3);
    expect(await txCount("ledger_entries")).toBe(3);

    const ps = await seedPartyRows();
    expect(ps.map((p) => p.name)).toEqual([
      "عميل اختبار أول",
      "عميل اختبار ثانٍ",
      "مورد اختبار أول",
    ]);
    expect(ps.map((p) => p.code)).toEqual(["C-001", "C-002", "S-001"]);
    expect(ps.map((p) => p.kind)).toEqual(["customer", "customer", "supplier"]);
    expect(ps.map((p) => p.opening_balance)).toEqual([5000, 3000, -2000]);

    const inv = await seedInvoiceRows();
    expect(inv.map((i) => i.number)).toEqual(["INV-2026-001", "INV-2026-002", "INV-2026-003"]);
    expect(inv.map((i) => i.total)).toEqual([1000, 500, 800]);

    const bal = await partyBalances();
    expect(bal).toEqual([-2000, 3000, 5000]);
  });

  it("a second restore over the restored data still succeeds (confirm=replace)", async () => {
    const r = await restorePath(archive, {
      sha256: sha(readFileSync(archive)),
      sizeBytes: statSync(archive).size,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await txCount("parties")).toBe(3);
    expect(await txCount("invoices")).toBe(3);
  });
});
