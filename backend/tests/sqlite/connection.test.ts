/**
 * T047 (specs/001-desktop-sqlite-engine): conformance of the SQLite connection layer
 * (connection.ts, transaction.ts, runtime.ts) — atomicity, read-your-writes, savepoint
 * nesting, the transaction clock, gate serialization and unbounded queueing, PRAGMA
 * assertions, boot-state refusals, autonomous-write replay, and durability under a
 * force-kill of the writer process.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execSync } from "node:child_process";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { bootSqlite, resolveSqliteMigrationsFolder, SqliteBootError } from "@/infrastructure/orm/sqlite/runtime.js";
import { closeSqlite, openSqlite, SqlitePragmaError, type SqliteConnections } from "@/infrastructure/orm/sqlite/connection.js";
import {
  withTenantTx,
  runInTransaction,
  runAutonomous,
  allowLedgerPartyRemap,
  sqliteDb,
  resetSqliteTransactionsForTests,
  SqliteGateReentryError,
} from "@/infrastructure/orm/sqlite/transaction.js";
import { nextSequenceValue } from "@/infrastructure/orm/sqlite/sequences.js";
import { transactionTimestamp } from "@/infrastructure/orm/sqlite/clock.js";
import { readSqliteFingerprint } from "@/infrastructure/orm/sqlite/schemaFingerprint.js";
import { openAndVerifyBackupV3Sync } from "@/infrastructure/backup/sqliteBackup.js";

const MIG = resolveSqliteMigrationsFolder();
/** The shipped journal: a FRESH database is created at its last entry. */
const JOURNAL = JSON.parse(readFileSync(join(MIG, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
const LAST_IDX = JOURNAL.entries.at(-1)!.idx;
let dir: string;
let conns: SqliteConnections | null = null;
const tenant = "11111111-1111-4111-8111-111111111111";

function boot(extra: Partial<Parameters<typeof bootSqlite>[0]> = {}) {
  const r = bootSqlite({ path: join(dir, "data", "motard.db"), migrationsDir: MIG, startupState: "FRESH", installationId: "inst-1", ...extra });
  conns = r.conns;
  return r;
}
function shutdown() {
  if (conns) closeSqlite(conns);
  conns = null;
  resetSqliteTransactionsForTests();
}
const count = (table: string) => conns!.reader.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
const insertTenant = (id: string, slug: string) => sql`INSERT INTO tenants (id, name, slug) VALUES (${id}, 'T', ${slug})`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "motard-conn-"));
});
afterEach(() => {
  shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe("transactions", () => {
  it("rolls back atomically on throw and reads its own writes before commit", async () => {
    boot();
    await expect(
      withTenantTx(tenant, async (tx) => {
        tx.run(insertTenant(tenant, "a"));
        // read-your-writes inside the transaction (writer)…
        expect(tx.get<{ n: number }>(sql`SELECT count(*) AS n FROM tenants`)!.n).toBe(1);
        // …while the reader still sees the last committed snapshot (like a second PG connection)
        expect(count("tenants")).toBe(0);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(count("tenants")).toBe(0);
    await withTenantTx(tenant, async (tx) => tx.run(insertTenant(tenant, "a")));
    expect(count("tenants")).toBe(1);
  });

  it("nests as savepoints: an inner failure rolls back only the inner work", async () => {
    boot();
    await withTenantTx(tenant, async (tx) => {
      tx.run(insertTenant(tenant, "outer"));
      await expect(
        withTenantTx(tenant, async (inner) => {
          inner.run(insertTenant(randomUUID(), "inner"));
          throw new Error("inner");
        }),
      ).rejects.toThrow("inner");
      await tx.transaction(async (sp) => sp.run(insertTenant(randomUUID(), "sp-ok")));
    });
    expect(conns!.reader.prepare("SELECT slug FROM tenants ORDER BY slug").pluck().all()).toEqual(["outer", "sp-ok"]);
  });

  it("refuses to join a transaction for another tenant (same as PG)", async () => {
    boot();
    await expect(
      withTenantTx(tenant, async () => withTenantTx(randomUUID(), async () => 1)),
    ).rejects.toThrow(/refusing to join an ambient transaction/);
  });

  it("uses one transaction clock for every default and trigger in a transaction", async () => {
    boot();
    let ts = "";
    await withTenantTx(tenant, async (tx) => {
      ts = transactionTimestamp();
      tx.run(insertTenant(tenant, "clock"));
      tx.run(sql`INSERT INTO ledger_entries (id, tenant_id, date, type, currency, cash_impact, debit, credit)
                 VALUES (${randomUUID()}, ${tenant}, '2026-03-01', 'cash', 'SYP', 'in', 500, 0)`);
      expect(transactionTimestamp()).toBe(ts);
    });
    expect(ts).toMatch(/\.\d{6}Z$/);
    expect(conns!.reader.prepare("SELECT updated_at FROM cashbox_daily_balances").pluck().get()).toBe(ts);
    expect(conns!.reader.prepare("SELECT ts FROM motard_tx_state").pluck().get()).toBe(ts);
    // the next transaction gets a strictly later clock
    let ts2 = "";
    await runInTransaction(async () => {
      ts2 = transactionTimestamp();
    });
    expect(ts2 > ts).toBe(true);
  });

  it("never interleaves two concurrent async transactions", async () => {
    boot();
    const log: string[] = [];
    const tx = (name: string) =>
      runInTransaction(async () => {
        log.push(`${name}:begin`);
        await new Promise((r) => setTimeout(r, 15));
        log.push(`${name}:end`);
      });
    await Promise.all([tx("A"), tx("B"), tx("C")]);
    expect(log).toEqual(["A:begin", "A:end", "B:begin", "B:end", "C:begin", "C:end"]);
  });

  it("queues 1,000 concurrent writers without a limit and commits them all in FIFO order", async () => {
    boot();
    await runInTransaction(async (tx) => tx.run(insertTenant(tenant, "q")));
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        withTenantTx(tenant, async (tx) => {
          order.push(i);
          tx.run(sql`INSERT INTO ledger_entries (id, tenant_id, date, type, currency, cash_impact, debit, credit)
                     VALUES (${randomUUID()}, ${tenant}, '2026-03-01', 'cash', 'SYP', 'none', ${i + 1}, 0)`);
          await Promise.resolve();
        }),
      ),
    );
    expect(count("ledger_entries")).toBe(1000);
    expect(order).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  }, 60_000);

  it("writes outside a transaction go through the gate; reads use the reader", async () => {
    boot();
    const db = sqliteDb();
    await db.run(insertTenant(tenant, "outside"));
    expect(count("tenants")).toBe(1);
    // a write while another transaction holds the gate waits for it (never joins it)
    let release!: () => void;
    const held = runInTransaction(async () => {
      await new Promise<void>((r) => (release = r));
      throw new Error("rolled back");
    });
    await new Promise((r) => setTimeout(r, 5));
    const outsideWrite = db.run(insertTenant(randomUUID(), "after"));
    release();
    await expect(held).rejects.toThrow("rolled back");
    await outsideWrite;
    expect(conns!.reader.prepare("SELECT slug FROM tenants ORDER BY slug").pluck().all()).toEqual(["after", "outside"]);
  });

  it("fails loudly instead of deadlocking on an independent write inside a transaction", async () => {
    boot();
    const { tenants } = await import("@/infrastructure/orm/sqlite/schemas/tenant.table.js");
    // A builder made OUTSIDE any transaction is bound to the gate (an independent write, like a
    // PG pool.query). Executing it while this context holds the gate would wait for itself forever.
    const independent = sqliteDb().insert(tenants).values({ id: tenant, name: "T", slug: "independent" });
    const outcome = await Promise.race([
      runInTransaction(async () => {
        await independent;
      }).then(
        () => "committed",
        (e: unknown) => (e instanceof SqliteGateReentryError ? "reentry-error" : `other: ${String(e)}`),
      ),
      new Promise((r) => setTimeout(() => r("deadlock"), 2000)),
    ]);
    expect(outcome).toBe("reentry-error");
    // the same builder still works on its own (outside any transaction)
    await independent;
    expect(count("tenants")).toBe(1);
    // sequences refuse to draw outside a transaction (they would write behind the gate)
    expect(() => nextSequenceValue("sync_outbox_seq_seq")).toThrow(/SEQUENCE_OUTSIDE_TX/);
    expect(await runInTransaction(async () => [nextSequenceValue("x_seq"), nextSequenceValue("x_seq")])).toEqual([1, 2]);
  });

  it("replays an autonomous write after the outer transaction rolls back (I-2)", async () => {
    boot();
    const bump = () =>
      runAutonomous(async (tx) => {
        tx.run(sql`INSERT INTO motard_sequences (name, value) VALUES ('doc_no', 1) ON CONFLICT (name) DO UPDATE SET value = value + 1`);
        return tx.get<{ value: number }>(sql`SELECT value FROM motard_sequences WHERE name = 'doc_no'`)!.value;
      });
    expect(await bump()).toBe(1); // outside a transaction: its own commit
    await expect(
      runInTransaction(async () => {
        expect(await bump()).toBe(2); // joined: visible inside
        throw new Error("settlement failed");
      }),
    ).rejects.toThrow("settlement failed");
    // PG committed number 2 on its own connection; SQLite replays it after the rollback
    expect(conns!.reader.prepare("SELECT value FROM motard_sequences WHERE name = 'doc_no'").pluck().get()).toBe(2);
    await runInTransaction(async () => {
      expect(await bump()).toBe(3);
    });
    expect(conns!.reader.prepare("SELECT value FROM motard_sequences WHERE name = 'doc_no'").pluck().get()).toBe(3);
  });

  it("session flags last only for their transaction and never commit set", async () => {
    boot();
    await runInTransaction(async (tx) => {
      await allowLedgerPartyRemap(tx);
      expect(tx.get<{ f: number }>(sql`SELECT allow_party_remap AS f FROM motard_tx_state`)!.f).toBe(1);
    });
    expect(conns!.reader.prepare("SELECT allow_party_remap + allow_dye_purge FROM motard_tx_state").pluck().get()).toBe(0);
    await expect(allowLedgerPartyRemap(null)).rejects.toThrow(/inside a transaction/);
  });
});

describe("connections and PRAGMAs", () => {
  it("asserts the durability and hardening PRAGMAs on both connections", () => {
    const r = boot();
    for (const db of [r.conns.writer, r.conns.reader]) {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("synchronous", { simple: true })).toBe(2);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("trusted_schema", { simple: true })).toBe(0);
      expect(db.pragma("cell_size_check", { simple: true })).toBe(1);
    }
    expect(r.conns.reader.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(r.conns.reader.readonly).toBe(true);
  });

  it("is fatal when a required PRAGMA does not hold (here: WAL is impossible in memory)", () => {
    expect(() => openSqlite(":memory:", { create: true })).toThrow(SqlitePragmaError);
    expect(() => openSqlite(":memory:", { create: true })).toThrow(/journal_mode is memory, required wal/);
  });
});

describe("boot states — install instance and integrity (T076, D-1)", () => {
  it("REUSE with the same marker (or both absent) opens; a different or missing marker refuses without changing the file", () => {
    boot({ installInstanceId: "guid-A" });
    shutdown();
    const file = join(dir, "data", "motard.db");
    const before = readFileSync(file);
    expect(boot({ startupState: "REUSE", installInstanceId: "guid-A", checkInstallInstance: true }).created).toBe(false);
    shutdown();
    for (const marker of ["guid-B", "", undefined]) {
      expect(() => boot({ startupState: "REUSE", installInstanceId: marker, checkInstallInstance: true }), String(marker)).toThrow(/INSTALL_INSTANCE_MISMATCH/);
    }
    // refused boots never wrote to the database
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("a database created without a marker is reused only while there is still no marker", () => {
    boot({ installInstanceId: undefined });
    shutdown();
    expect(boot({ startupState: "REUSE", installInstanceId: "", checkInstallInstance: true }).created).toBe(false);
    shutdown();
    expect(() => boot({ startupState: "REUSE", installInstanceId: "guid-new", checkInstallInstance: true })).toThrow(/INSTALL_INSTANCE_MISMATCH/);
  });

  it("an adopted instance (update hand-off / Open existing) is recorded, and later boots reuse it", () => {
    boot({ installInstanceId: "guid-A" });
    shutdown();
    const r = boot({ startupState: "REUSE", installInstanceId: "guid-B", installationId: "inst-2", adoptInstallInstance: true });
    expect(r.meta.install_instance_id).toBe("guid-B");
    expect(JSON.parse(r.meta.adopted_installation_ids)).toEqual(["inst-2"]);
    shutdown();
    expect(boot({ startupState: "REUSE", installInstanceId: "guid-B", checkInstallInstance: true }).created).toBe(false);
    shutdown();
    expect(() => boot({ startupState: "REUSE", installInstanceId: "guid-A", checkInstallInstance: true })).toThrow(/INSTALL_INSTANCE_MISMATCH/);
  });

  it("REUSE refuses a database that fails integrity_check", () => {
    boot();
    shutdown();
    const file = join(dir, "data", "motard.db");
    // corrupt the b-tree page-type byte of a real table's root page (file header + schema intact)
    const raw = new Database(file);
    raw.pragma("wal_checkpoint(TRUNCATE)");
    const pageSize = raw.pragma("page_size", { simple: true }) as number;
    const root = raw.prepare(`SELECT rootpage FROM sqlite_master WHERE name = 'parties'`).pluck().get() as number;
    raw.close();
    const buf = readFileSync(file);
    buf[(root - 1) * pageSize] = 0x00; // not a valid b-tree page type
    writeFileSync(file, buf);
    expect(() => boot({ startupState: "REUSE" })).toThrow(/INTEGRITY_FAILED|SCHEMA_UNVERIFIED|malformed|SQLITE_CORRUPT/);
  });
});

describe("boot states", () => {
  it("FRESH creates the file atomically with motard_meta, and refuses an existing file", () => {
    const r = boot({ expectedDataId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", installInstanceId: "guid-1", appVersion: "2.0.0" });
    expect(r.created).toBe(true);
    expect(r.meta).toMatchObject({
      data_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      created_by_installation_id: "inst-1",
      install_instance_id: "guid-1",
      schema_journal_idx: LAST_IDX,
      app_version_last_opened: "2.0.0",
    });
    expect(existsSync(join(dir, "data", "motard.db.creating"))).toBe(false);
    shutdown();
    expect(() => boot()).toThrow(SqliteBootError);
    expect(() => boot()).toThrow(/FRESH_TARGET_EXISTS/);
  });

  it("never creates a database implicitly", () => {
    expect(() => boot({ startupState: undefined })).toThrow(/DATABASE_MISSING/);
    expect(existsSync(join(dir, "data", "motard.db"))).toBe(false);
  });

  it("reopens an existing file, and refuses a foreign data_id or a newer schema", () => {
    boot({ expectedDataId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    shutdown();
    expect(boot({ startupState: "REUSE", expectedDataId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }).created).toBe(false);
    shutdown();
    expect(() => boot({ startupState: "REUSE", expectedDataId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })).toThrow(/DATA_ID_MISMATCH/);
    const raw = new Database(join(dir, "data", "motard.db"));
    raw.prepare("UPDATE motard_meta SET schema_journal_idx = 99").run();
    raw.close();
    expect(() => boot({ startupState: "REUSE" })).toThrow(/SCHEMA_TOO_NEW/);
  });

  it("refuses to serve a file whose schema differs from the committed fingerprint", () => {
    boot();
    shutdown();
    const raw = new Database(join(dir, "data", "motard.db"));
    const idx = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name LIMIT 1").pluck().get() as string;
    raw.exec(`DROP INDEX "${idx}"`);
    raw.close();
    expect(() => boot({ startupState: "REUSE" })).toThrow(/SCHEMA_UNVERIFIED/);
  });

  it("applies a pending migration forward only, after a consistent snapshot", () => {
    boot();
    shutdown();
    // a binary one migration ahead: copy the migrations and append a probe migration
    const mig2 = join(dir, "mig2");
    cpSync(MIG, mig2, { recursive: true });
    const next = LAST_IDX + 1;
    const probeTag = `${String(next).padStart(4, "0")}_probe`;
    writeFileSync(join(mig2, `${probeTag}.sql`), `CREATE TABLE "motard_probe" ("id" INTEGER NOT NULL, CONSTRAINT "motard_probe_pkey" PRIMARY KEY ("id")) STRICT;`);
    const entries = [...JOURNAL.entries, { idx: next, tag: probeTag }];
    writeFileSync(join(mig2, "meta", "_journal.json"), JSON.stringify({ version: 7, dialect: "sqlite", entries }));
    // regenerate the expected fingerprint for that binary from a scratch build
    const scratch = new Database(":memory:");
    scratch.pragma("trusted_schema = OFF");
    for (const e of entries) scratch.exec(readFileSync(join(mig2, `${e.tag}.sql`), "utf8"));
    writeFileSync(join(mig2, "meta", "schema-fingerprint.json"), JSON.stringify(readSqliteFingerprint(scratch, next)));
    scratch.close();
    const snapDir = join(dir, "snapshots");
    mkdirSync(snapDir, { recursive: true });
    const r = boot({ startupState: "REUSE", migrationsDir: mig2, snapshotDir: snapDir });
    expect(r.appliedMigrations).toEqual([probeTag]);
    expect(r.meta.schema_journal_idx).toBe(next);
    expect(r.snapshotPath && existsSync(r.snapshotPath)).toBe(true);
    // The pre-migration snapshot is a full, VERIFIED v3 backup of the database as it was (LAST_IDX).
    const opened = openAndVerifyBackupV3Sync(r.snapshotPath!, { keep: true });
    try {
      expect(opened.manifest.schema.journalIdx).toBe(LAST_IDX);
      const snap = new Database(opened.databasePath, { readonly: true });
      expect(snap.prepare("SELECT schema_journal_idx FROM motard_meta").pluck().get()).toBe(LAST_IDX);
      snap.close();
    } finally {
      rmSync(opened.workDir, { recursive: true, force: true });
    }
  });
});

describe("durability", () => {
  it.skipIf(process.platform !== "win32")(
    "a force-killed writer loses no committed row and leaves integrity_check = ok",
    async () => {
      const path = join(dir, "data", "motard.db");
      const child = spawn("npx", ["tsx", join(__dirname, "fixtures", "writer-child.mts"), path], {
        cwd: join(__dirname, "../.."),
        shell: true,
        stdio: ["ignore", "pipe", "inherit"],
      });
      const committed: string[] = [];
      let buf = "";
      let killed = false;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("child never reached 300 commits")), 90_000);
        child.stdout!.on("data", (d: Buffer) => {
          buf += d.toString();
          const lines = buf.split("\n");
          buf = lines.pop()!;
          for (const l of lines) if (/^[0-9a-f-]{36}$/.test(l.trim())) committed.push(l.trim());
          if (committed.length >= 300 && !killed) {
            killed = true;
            clearTimeout(timer);
            // hard kill mid-loop: no graceful shutdown, no checkpoint
            execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
            resolve();
          }
        });
        child.on("error", reject);
      });
      await new Promise((r) => setTimeout(r, 500));
      const db = new Database(path);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      const have = new Set(db.prepare("SELECT id FROM ledger_entries").pluck().all() as string[]);
      const lost = committed.filter((id) => !have.has(id));
      expect(lost).toEqual([]);
      // every committed ledger row carried its trigger work
      expect(db.prepare("SELECT count(*) FROM cashbox_daily_balances").pluck().get()).toBe(1);
      db.close();
    },
    120_000,
  );
});
