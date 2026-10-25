// Phone database runtime (replaces backend/src/infrastructure/orm/sqlite/runtime.ts, which reads the
// migrations folder with node:fs). Opens the shim connection like connection.ts does, applies the
// bundled migrations with the same bookkeeping (motard_meta.schema_journal_idx), and starts the shared
// transaction layer. One connection serves reads and writes: use-cases run one at a time (serialExecutor).
import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { randomUUID } from "node:crypto";
import { withExactIntegers } from "@backend/infrastructure/orm/sqlite/exactIntegers";
import { registerNumericFunctions } from "@backend/infrastructure/orm/sqlite/numericFunctions";
import { formatMicrosUtc, nextMonotonicMicros } from "@backend/infrastructure/orm/sqlite/clock";
import {
  initSqliteTransactions,
  resetSqliteTransactionsForTests,
} from "@backend/infrastructure/orm/sqlite/transaction";
import type { SqliteConnections, SqliteDb } from "@backend/infrastructure/orm/sqlite/connection";
import { JOURNAL_LAST_IDX, MIGRATIONS } from "./generated/migrations";
import type { ShimDatabase } from "../platform/sqlite/types";

export class RuntimeError extends Error {
  constructor(
    readonly code: "PRAGMA_FAILED" | "SCHEMA_TOO_NEW" | "MIGRATION_FAILED",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "RuntimeError";
  }
}

export interface PhoneRuntime {
  conns: SqliteConnections;
  appliedMigrations: string[];
  /** The journal index the database is at after opening (-1 never happens after a successful open). */
  journalIdx: number;
}

function setAndAssert(db: ShimDatabase, pragma: string, value: string | number, expected: unknown) {
  db.pragma(`${pragma} = ${value}`);
  const actual = db.pragma(pragma, { simple: true });
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new RuntimeError(
      "PRAGMA_FAILED",
      `PRAGMA ${pragma} is ${String(actual)}, required ${String(expected)}`,
    );
  }
}

function readStoredJournalIdx(conn: ShimDatabase): number {
  const hasMeta = conn
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'motard_meta'")
    .get();
  if (!hasMeta) return -1;
  const row = conn
    .prepare("SELECT schema_journal_idx AS idx FROM motard_meta WHERE id = 1")
    .get() as { idx: number | bigint } | undefined;
  // The table exists but no row yet: the migrations ran in one transaction, so the schema is complete.
  return row ? Number(row.idx) : JOURNAL_LAST_IDX;
}

export interface OpenRuntimeOptions {
  /**
   * Default true: a driver that cannot register the `motard_*` SQL functions refuses to open. Only the S1 spike
   * passes false, to report migrations (S1-2) and functions (S1-4) separately.
   */
  requireFunctions?: boolean;
}

export function openRuntime(conn: ShimDatabase, options: OpenRuntimeOptions = {}): PhoneRuntime {
  // The pragmas connection.ts asserts: WAL, synchronous FULL, foreign keys ON, trusted_schema OFF.
  setAndAssert(conn, "journal_mode", "WAL", "wal");
  setAndAssert(conn, "synchronous", "FULL", 2);
  setAndAssert(conn, "foreign_keys", "ON", 1);
  setAndAssert(conn, "trusted_schema", "OFF", 0);
  setAndAssert(conn, "cell_size_check", "ON", 1);
  if (options.requireFunctions !== false) {
    registerNumericFunctions(conn as unknown as Database.Database);
  }

  const stored = readStoredJournalIdx(conn);
  if (stored > JOURNAL_LAST_IDX) {
    throw new RuntimeError(
      "SCHEMA_TOO_NEW",
      `database schema ${stored} is newer than this app (${JOURNAL_LAST_IDX})`,
    );
  }
  const pending = MIGRATIONS.filter((m) => m.idx > stored);
  const applied: string[] = [];
  if (pending.length) {
    conn.exec("BEGIN IMMEDIATE");
    try {
      for (const m of pending) {
        conn.exec(m.sql);
        applied.push(m.tag);
      }
      // motard_meta is created by migration 0000 and its row by ensureMeta; later migrations bump the index.
      if (stored >= 0) {
        conn
          .prepare("UPDATE motard_meta SET schema_journal_idx = ? WHERE id = 1")
          .run(JOURNAL_LAST_IDX);
      }
      conn.exec("COMMIT");
    } catch (error) {
      if (conn.inTransaction) conn.exec("ROLLBACK");
      throw new RuntimeError(
        "MIGRATION_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const exact = withExactIntegers(conn as unknown as Database.Database);
  const db = drizzle(exact) as unknown as SqliteDb;
  const conns: SqliteConnections = {
    path: "motard.db",
    writer: exact,
    reader: exact,
    writerDb: db,
    readerDb: db,
  };
  initSqliteTransactions(conns);
  return { conns, appliedMigrations: applied, journalIdx: JOURNAL_LAST_IDX };
}

export function closeRuntime(runtime: PhoneRuntime): void {
  resetSqliteTransactionsForTests();
  runtime.conns.writer.close();
}

/**
 * Creates the single `motard_meta` row (id = 1) when absent, with the column values
 * backend/src/infrastructure/orm/sqlite/runtime.ts writes for a new database (createFresh).
 */
export function ensureMeta(
  conn: ShimDatabase,
  ids: { tenantId: string; installationId: string; appVersion?: string },
): void {
  const existing = conn.prepare("SELECT id FROM motard_meta WHERE id = 1").get();
  if (existing) return;
  conn
    .prepare(
      `INSERT INTO motard_meta (id, data_id, created_by_installation_id, install_instance_id, tenant_id, schema_journal_idx, app_version_last_opened, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      ids.installationId,
      null,
      ids.tenantId,
      JOURNAL_LAST_IDX,
      ids.appVersion ?? null,
      formatMicrosUtc(nextMonotonicMicros()),
    );
}
