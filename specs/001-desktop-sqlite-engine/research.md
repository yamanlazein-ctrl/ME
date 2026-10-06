# Phase 0 Research: Desktop Local Database Replacement (PostgreSQL → SQLite)

**Feature**: `001-desktop-sqlite-engine` | **Date**: 2026-10-03 | **Plan**: [plan.md](./plan.md)

Sources: `docs/PRD-DESKTOP-SQLITE.md`, `ERP_GENOME.md`, [spec.md](./spec.md),
`.specify/memory/constitution.md`, plus targeted repository reads (cited as `path:line`).
`docs/POSTGRES-VS-SQLITE-FORENSIC-AUDIT.md` was not used.

Each item records **Decision / Rationale / Alternatives**. Facts are labelled **VERIFIED** (read in
code this session) or **INVESTIGATE** (evidence missing — becomes an explicit task before the
dependent stage; see plan §Investigation Items).

---

## R0. Verified baseline facts

| # | Fact | Evidence |
|---|---|---|
| F1 | Bundled Node runtime is **v22.14.0** (win-x64). | `desktop/src-tauri/resources/node.exe --version`; `desktop/scripts/*`: `NODE_VERSION = "22.14.0"` |
| F2 | Backend uses `drizzle-orm ^0.45.2`, `pg ^8.15.6`, `fflate`, Express 4, zod. No SQLite dependency exists. | `backend/package.json` |
| F3 | One backend serves cloud and desktop. Cloud runs `node dist/presentation/server.js` (Docker). The desktop esbuild-bundles the same `presentation/server.ts`. Mode is switched by `DESKTOP_DEPLOY` and `DESKTOP_PIPE`. | `backend/Dockerfile`; `desktop/scripts/bundle-server.mjs:56`; `server.ts:551-660` |
| F4 | The live PostgreSQL schema (journal idx 99, 100 migrations) has **53 tables**, 213 indexes, 193 constraints, 7 triggers, 49 RLS policies and 3 extensions (`pg_trgm`, `plpgsql`, `uuid-ossp`). The constraints are 53 PK, 22 UNIQUE, 45 CHECK and 73 FK. Of the FKs, 63 are NO ACTION, 8 CASCADE and 2 SET NULL; none are deferrable. 30 indexes are partial, expression or GIN. | `backend/src/infrastructure/orm/migrations/meta/schema-fingerprint.json` |
| F5 | **Table history, reconstructed from all 100 journal migrations in order**:<br>• **54** tables were ever created.<br>• **1** was intentionally dropped: `party_balances`, created in `0020` and dropped in `0038_drop_party_balances.sql:10` as an unused balance cache.<br>• **0** were renamed.<br>• **53 are currently live**, matching the fingerprint exactly.<br>`ERP_GENOME.md`'s "54 tables" counts the dropped table. | migration scan; fingerprint |
| F6 | Of the 53 live tables, **50** are defined in Drizzle schemas and **3 exist only in raw SQL**: `financial_operations`, `sync_conflicts`, `sync_tombstones`. Drizzle defines no table that is not live. | migration scan vs `orm/schemas/*.ts` |
| F6a | **Relationships, reconciled column by column**:<br>• Drizzle declares **86** `.references()`; this is the source of the genome's "86".<br>• The live database enforces **73** FK constraints.<br>• **62** Drizzle declarations match a live FK. **11** live FKs exist only in raw SQL: composite `(tenant_id, license_id)` and `(tenant_id, device_id/user_id)` FKs, `tenants.owner_user_id`, `tenants.activation_id`, `sync_devices.device_registration_id`, and the raw-only tables' FKs.<br>• **24** Drizzle declarations are **not** enforced in the database. These are `tenant_id → tenants` on `attachments`, `audit_logs`, `cashbox_sessions`, `colors`, `day_closes`, `document_sequences`, `expenses`, `fabrics`, `idempotency_keys`, `invoice_lines`, `invoices`, `ledger_entries`, `manual_movements`, `notifications`, `order_items`, `orders`, `parties`, `print_jobs`, `return_lines`, `returns`, `rolls`, `settings`, `sync_device_authorized_users` and `vouchers`. `0001_initial.sql` created those columns without `REFERENCES`, and no later migration added them. | fingerprint constraints vs Drizzle parse; `0001_initial.sql` |
| F6b | **Effective schema ≠ the CREATE statements.** For example, `20260912_batch1_tombstones_conflicts.sql` used `CREATE TABLE IF NOT EXISTS` against a table `0058` had already created, so its column list never applied. `20261021_reconcile_tombstone_schema_drift.sql` documents and repairs this. The live schema is therefore taken only from applying all migrations in journal order (the fingerprint), never from reading individual files. | `20261021_reconcile_tombstone_schema_drift.sql:12-16` |
| F7 | Live triggers: `trg_ledger_entries_append_only`, `cashbox_daily_ledger_ai`, `cashbox_daily_ledger_au`, `cashbox_daily_manual_aiud`, `trg_license_audit_events_no_update`, `trg_license_audit_events_no_delete` and `trg_sync_inbox_applied_seq`. Seven app plpgsql functions back them. | fingerprint `triggers` / `functions` |
| F8 | The desktop cluster is `initdb -E UTF8 --locale=C`. | `desktop/scripts/build-pgdata-template.mjs:112` |
| F9 | Search is `ILIKE '%term%'` with escaped metacharacters (`\`). `pg_trgm` is used **only** for GIN indexes. There is no `similarity()` ranking and no Arabic normalization. | `infrastructure/utils/likeEscape.ts`; `20261013_pg_trgm_search.sql`; grep: 0 `similarity` hits |
| F10 | Money columns: `numeric(14,2)` (most), plus `(18,6)`, `(14,3)`, `(14,4)`, `(6,2)` and `(5,4)`. Drizzle reads them with `mode: "number"`. App rounding policy is `round2dp`, with "no integer minor units in app code". | schemas; `docs/money-representation.md` |
| F11 | Currencies allowed by CHECK constraints: `syp`, `usd`, `eur`. | fingerprint constraints (`parties`, `rolls`) |
| F12 | All 107 `timestamp` columns are `withTimezone: true`. Dates use `date`. 33 `jsonb` columns. 40 `defaultRandom()` UUIDs and 72 `defaultNow()` defaults. | schemas |
| F13 | PostgreSQL-specific usage in non-migration backend source:<br>• SQL text: 205 `sql\`` fragments (45 files), 156 `::` casts (34), 55 jsonb/`->>` (19), 154 `now()`/`CURRENT_*` (75), 39 `ILIKE` (15)<br>• Writes and locks: 120 `RETURNING` (42), 26 `ON CONFLICT` (12), 35 `FOR UPDATE` (17), 2 `SKIP LOCKED`, 5 advisory locks (5)<br>• Raw access: 73 raw `.query(` (10 files), 9 `set_config`/`SET LOCAL` (2) | grep counts this session |
| F14 | Transactions: 44 `db.transaction(async …)` in 23 files, 116 ambient-tx helper uses, `withTenantTx`. AsyncLocalStorage ambient transactions are in `orm/ambient-tx.ts`. | `orm/drizzle.ts:113-218`; grep |
| F15 | Coupling: 98 non-test files import `orm/drizzle`, there are 34 `Postgres*Repository` classes, and 12 use-case/route files import `drizzle-orm` directly. | grep |
| F16 | Document numbers come from the transactional `document_sequences` counter (`INSERT … ON CONFLICT DO UPDATE … RETURNING`, `GREATEST`), not from PostgreSQL sequences. Two allocation paths use the global `db`, not the caller's tx. | `infrastructure/utils/documentNumbers.ts:133,204,317,481` |
| F17 | PostgreSQL error codes are mapped to user messages: `23505`, `23503`, `23502`, `23514`, `22P02`. | `infrastructure/errors/persistenceErrorMessage.ts` (grep) |
| F18 | The sync hub is the separate PostgreSQL server (`CENTRAL_SYNC_URL`). Desktops push and pull. The `applied_seq` trigger and the pull cursor live on the hub's `sync_inbox`. | `env.ts:89-90`; `20261016_sync_inbox_applied_seq.sql`; `sync.route.ts:891-915` |
| F19 | Desktop runtime (Rust): `runtime/stack.rs` (2,010 lines, ~200 PostgreSQL/pgdata references), `db_meta.rs`, `runtime/cluster_identity.rs`, `runtime/ports.rs`. Single instance comes from `tauri_plugin_single_instance`. | `desktop/src-tauri/src/**` line counts; `main.rs` |
| F20 | Backup v2 = zip of per-table NDJSON + `manifest.json` + `manifest.sha256`, via PostgreSQL-only SQL (`REPEATABLE READ READ ONLY`, `row_to_json`, `session_replication_role=replica`, `setval`). Only the manual download is verified. | `infrastructure/backup/portableBackup.ts`; `backup.route.ts:178-189`; `backupScheduler.ts:109-131` |
| F21 | Test assets: 113 backend tests, 59 frontend tests, and e2e suites `cert-financial`, `cert-route` and `cert-ui`. Harnesses include `durability-proof.mjs`, `restore-drill.mjs`, `verify-sync-multidevice.mjs` and `seed-test-baseline.mjs`. The backend test runner requires a live PostgreSQL (`ensure-test-db.mjs`). | repository listing |

---

## R1. SQLite driver

- **Decision**: use `better-sqlite3` (native SQLite, with a prebuilt binary for Node 22 / win-x64 / N-API) through
  Drizzle's `better-sqlite3` driver and `drizzle-orm/sqlite-core`.
- **Rationale**:
  - It is mature and gives deterministic control of PRAGMAs (journal mode, synchronous, foreign keys).
  - It has an online backup API (`db.backup()`) for consistent snapshots without stopping the app (BK-6).
  - It supports user-defined SQL functions, which are needed for exact-decimal helpers and any PostgreSQL-function shims.
  - Its synchronous calls make the commit point explicit: a `COMMIT` that returns has been written per the durability PRAGMAs.
  - It ships a recent SQLite (JSON1 `->`/`->>`, `RETURNING`, UPSERT, `max()`/`min()` scalars).
- **Alternatives considered**:
  - `node:sqlite` (built into Node 22.14): still experimental. Its API and stability are not guaranteed across the multi-year update horizon (LC-5), and it lacks a backup API in 22.x. Rejected for now; re-evaluate once it is stable.
  - `@libsql/client` (local file): async transactions fit the existing code shape. However, it adds a second native runtime and a vendor fork of SQLite, and gives less direct PRAGMA and backup control. Kept as the fallback if R3's gate design fails its concurrency tests.
- **INVESTIGATE I-1**: packaging the `.node` binary through `desktop/scripts/bundle-server.mjs`. The esbuild bundle cannot inline native addons, so the addon must be shipped next to `server.mjs` and listed in `resource-manifest.json`.

## R2. Engine split inside the shared backend (OQ-9)

- **Decision**: add a **build-time + runtime engine boundary**:
  1. Keep `application/ports/I*Repository` as the boundary. They already exist for most domains.
  2. Add `infrastructure/repositories/sqlite/Sqlite*Repository` implementations beside the existing
     `Postgres*Repository` classes. The cloud classes stay **unchanged**.
  3. `infrastructure/di/container.ts` selects the implementation from `DB_ENGINE`
     (`postgres` by default; `sqlite` set by the desktop runtime).
  4. Move every non-repository file that builds queries behind repository ports first (stage S1). The
     measured count is about 25 *query* files: 12 import `drizzle-orm` directly (F15), plus about 13 that build queries
     through `orm/drizzle` (sync, licensing, auth, backup, idempotency, documentNumbers, search, reports,
     health). About 15 more routes are *transaction-only* and need only the engine-neutral transaction facade.
     These were measured 2026-10-03, and tasks T015 produces the authoritative list. This is a behavior-preserving move proven by the
     existing PostgreSQL tests, before any SQLite code exists.
  5. Load drivers lazily, `pg` only for postgres and `better-sqlite3` only for sqlite, so neither
     engine loads the other's native code.
- **Rationale**: the cloud PostgreSQL path stays byte-for-byte the same in behavior (FR-006,
  Principle I/IX). Each SQLite repository can be parity-tested against its PostgreSQL twin through the same
  port. Domain and use-case logic is reused unchanged.
- **Alternatives considered**:
  - Rewrite the repositories dialect-neutrally with conditional SQL. This changes the cloud code path and raises regression risk for the cloud. Rejected.
  - Two backend forks. This doubles the business logic and breaks Principle IX. Rejected.
- **Consequence**: the repository layer is duplicated, about 34 classes plus helpers. This is accepted in Complexity Tracking.

## R3. Connection lifecycle and transactions

- **Decision**:
  - **Two connections per process**:
    - **Writer**: one connection. Every write transaction runs `BEGIN IMMEDIATE … COMMIT`, and each one goes through
      an **async write gate**, a FIFO mutex.
    - **Reader**: one connection for reads outside a transaction. WAL gives it a committed snapshot.
  - The existing AsyncLocalStorage ambient transaction (`ambient-tx.ts`) carries the writer handle. Code
    inside a transaction keeps reading its own uncommitted writes.
  - `withTenantTx` and `db.transaction(async tx => …)` keep their signatures. The SQLite implementation is
    `gate.acquire → BEGIN IMMEDIATE → await fn(tx) → COMMIT | ROLLBACK → release`.
  - A write issued outside any transaction is wrapped as a single-statement transaction through the gate.
  - A nested `transaction()` inside an ambient one becomes a `SAVEPOINT`, matching Drizzle's PostgreSQL nested-transaction behavior.
- **Rationale**:
  - SQLite allows one writer. Taking it up front (IMMEDIATE) removes `SQLITE_BUSY` upgrade failures.
  - Serializing writers is at least as strong as PostgreSQL's row locks and advisory locks for every
    contended resource: rolls, document numbers, claims and cash box. The observable outcome is the same: no
    double consumption.
  - Async code inside a transaction cannot interleave another request's statements, because the gate is held across awaits.
- **Parity hazard (INVESTIGATE I-2)**: in PostgreSQL, code that uses the **global `db` inside another
  transaction's scope** runs as a separate, autonomously committed transaction. One example is the `documentNumbers.ts:133` path. On a
  single writer connection that call would either deadlock on the gate or silently join the open
  transaction. Every such call site must be listed and handled explicitly:
  - keep the autonomous semantics by running it on a dedicated short connection after the outer transaction, or
  - prove that joining changes no result.
- **Pool sizing**: one database file for one company on one machine. There is no pool beyond writer + reader, and the
  writer gate queue is unbounded (no artificial limit).

## R4. Durability PRAGMAs

- **Decision**: on every connection:
  - `journal_mode=WAL`
  - `synchronous=FULL`
  - `foreign_keys=ON`
  - `busy_timeout` (reader only; the writer never waits on itself)
  - `trusted_schema=OFF`
  - `cell_size_check=ON`

  On clean shutdown, run `wal_checkpoint(TRUNCATE)`. `journal_mode=OFF`/`MEMORY` and `synchronous=OFF`/`NORMAL` are
  prohibited (Principle IV).
- **Rationale**: WAL with `FULL` syncs the WAL on every commit, so a commit that has returned survives power
  loss (C-10). `foreign_keys` is off by default in SQLite and must be enabled per connection (C-4).
- **Proof**: crash, force-kill and VM hard-reset tests in the quickstart (SC-004). This is not taken on trust.

## R5. Exact decimal money (FR-014, SC-001)

- **Decision**: store each PostgreSQL `numeric(p,s)` column in SQLite as an **INTEGER scaled by 10^s**, through a Drizzle
  `customType` per scale:
  - **On write**: convert the JS number to its shortest decimal string, then round **half away from zero** to `s`
    digits. This is PostgreSQL's numeric assignment rounding. The resulting integer is stored.
  - **On read**: integer / 10^s, returned as a JS number. This is the same value type the code receives today with `mode: "number"`.
  - **Raw SQL aggregates** (`SUM`, `COALESCE(SUM(...))`, `debit - credit`) run on integers, so they are exact. The SQLite
    repository helpers apply the scale at the boundary. **Mixed-scale SQL arithmetic** (for example amount × rate
    inside SQL) must be inventoried (**INVESTIGATE I-3**) and either moved to the boundary or given
    explicit rescaling, with a parity test for each.
  - `numeric(18,6)` values (up to 10^18) use `safeIntegers` (BigInt) on those columns in the driver.
- **Rationale**: exact sums equal to PostgreSQL `numeric`; no float accumulation in SQL. Application code and the
  `round2dp` policy are untouched, because the scaling is storage-only (C-6).
- **Alternatives considered**:
  - SQLite `REAL`: binary floating point drifts in `SUM` (the very failure `docs/money-representation.md` documents). Rejected.
  - Canonical decimal `TEXT` with custom `dec_*` functions: exact, but requires rewriting every aggregate and comparison, and sorting by text breaks numeric order. Rejected.
- **Constitution note**: `docs/money-representation.md` forbids integer minor units *in app code*. This
  decision does not reinterpret values in app code. It is recorded in plan Complexity Tracking.

## R6. Type mapping (non-money)

| PostgreSQL | SQLite storage | Boundary rule |
|---|---|---|
| `uuid` | `TEXT` (lower-case canonical) | `defaultRandom()` → `$defaultFn(randomUUID)` |
| `timestamptz` | `TEXT` ISO-8601 UTC, fixed width `YYYY-MM-DDTHH:MM:SS.ffffffZ` | Returns `Date`, as now. Fixed width keeps lexical order equal to time order for keyset cursors. |
| `date` | `TEXT` `YYYY-MM-DD` | Same string the code receives today. INVESTIGATE I-4: confirm the current `date` mode returns strings. |
| `boolean` | `INTEGER` 0/1 with CHECK | Mapped to `boolean`. |
| `jsonb` | `TEXT` JSON with `CHECK (json_valid(col))` | Parsed and serialized at the boundary. INVESTIGATE I-5: does any code hash or compare jsonb *text*? PostgreSQL jsonb normalizes key order. |
| `bigserial` / `serial` | `INTEGER PRIMARY KEY AUTOINCREMENT` | Same monotonic, never-reused property. |
| `varchar(n)` | `TEXT` + `CHECK(length(col) <= n)` | PostgreSQL rejects over-length values. The CHECK reproduces that, and the error is mapped to the same message (R13). |
| CHECK `col = ANY(ARRAY[...])` | `CHECK (col IN (...))` | All 45 CHECK constraints are translated one-for-one. |

- **`now()` semantics**: PostgreSQL `now()` is the **transaction start time**, equal for every statement in a
  transaction. SQLite's `'now'` is per statement. **Decision**: a transaction clock is captured at `BEGIN` and kept in the ambient
  context. `defaultNow()` columns and the SQLite repository helpers use it. INVESTIGATE I-6: list the code that
  depends on equal timestamps within a transaction.

## R7. PostgreSQL-specific behavior inventory → SQLite equivalent (DB-7, FR-012)

| PostgreSQL mechanism (VERIFIED location) | Observable behavior | SQLite equivalent |
|---|---|---|
| `trg_ledger_entries_append_only` (`0036b`, rewritten in `20261011`) | No DELETE. UPDATE only for `status → cancelled`; financial columns immutable. | `BEFORE DELETE` / `BEFORE UPDATE` triggers using `RAISE(ABORT, '<same message>')`, with identical predicates. |
| `app.allow_party_remap` GUC (`drizzle.ts:153`) checked by the ledger guard | Merge may remap `party_id` inside one transaction. | A connection-local `TEMP` table `motard_session_flags(flag)` that is set and cleared inside the transaction. The trigger checks `EXISTS(SELECT 1 FROM temp.motard_session_flags WHERE flag='allow_party_remap')`. |
| Dye purge drops and recreates the append-only trigger at runtime (`dyePurgeRepository.ts:~595`) | Purge can delete scoped ledger rows atomically. | A session flag `allow_dye_purge` that the trigger honors. No runtime DDL. INVESTIGATE I-7: read the exact purge predicate and confirm equivalence. |
| `trg_license_audit_events_no_update` / `_no_delete` | License audit is append-only. | `BEFORE UPDATE` / `BEFORE DELETE` `RAISE(ABORT)`. |
| `cashbox_daily_*` triggers + `cashbox_daily_apply_delta` / `cashbox_daily_shift_all` (`20260928`) | Daily closing balance per (tenant, currency, date) stays consistent with ledger `cash_impact` rows and `manual_movements`, including cancellation reversal and edits. Later days shift. | `AFTER INSERT` / `AFTER UPDATE OF status, cash_impact, debit, credit` on `ledger_entries` and `AFTER INSERT/UPDATE/DELETE` on `manual_movements`, performing the same UPSERT + `UPDATE … WHERE balance_date > d`. The opening-balance shift (`shift_all`) is called from the same code path. INVESTIGATE I-8: transcribe the function bodies exactly, including how `v_prev` is derived. Parity is checked row-for-row on `cashbox_daily_balances`. |
| `trg_sync_inbox_applied_seq` + `sync_inbox_applied_seq` + shared advisory lock (`20261016`) | Applied units get a monotonic `applied_seq`, and a pull never observes a gap. | Hub-side (F18). On SQLite, if a desktop writes `sync_inbox` at all (INVESTIGATE I-9), a `BEFORE`-equivalent `AFTER UPDATE` trigger sets `applied_seq = (SELECT next FROM motard_sequences …)`. The single writer makes commit order equal assignment order, so a reader cannot see a gap. |
| Row-level security (49 policies, `set_config('app.current_tenant_id')`) | Rows of other tenants are invisible. | No RLS in SQLite. The desktop database holds one company, and every SQLite repository query carries the `tenant_id` predicate. A **tenant-isolation test** seeds two tenants and asserts zero cross-tenant reads and writes through every port. INVESTIGATE I-10: confirm the PostgreSQL repositories already add `tenant_id` predicates everywhere, not relying on RLS alone. |
| `FOR UPDATE` (35), `SKIP LOCKED` (2), `pg_advisory_xact_lock` (5) | Serialized access to contended rows (rolls, cash box, ledger, day/year lock, sync claims). | Removed. The single writer with `BEGIN IMMEDIATE` (R3) serializes. Concurrency parity tests cover the same contention scenarios. |
| `ON CONFLICT … DO UPDATE/NOTHING` (26), `RETURNING` (120) | Upsert and read-back. | Native SQLite UPSERT and `RETURNING`. Drizzle sqlite-core supports both. |
| `GREATEST` / `LEAST` (17) | Scalar max/min. | `max(a,b)` / `min(a,b)` scalars. **NULL difference**: PostgreSQL ignores NULLs, SQLite returns NULL. Wrap with `COALESCE` per call site and test. |
| `ILIKE '%x%'` with `\` escape (39), locale C (F8) | ASCII-only case-insensitive contains match. | SQLite `LIKE … ESCAPE '\'`, which is ASCII-only case-insensitive by default. This is an exact match for locale C. A Drizzle helper adds `ESCAPE`. |
| `pg_trgm` GIN indexes (F9) | Performance only. | None at first. Measure at the OQ-4 gate. If it is missed, add an FTS5 `trigram` table as a **prefilter only**, with the final predicate still `LIKE` so results stay identical. |
| `::` casts (156), `date_trunc` / `EXTRACT` / `interval` (4), `string_agg` / `array_agg` / `ANY()` (13), `row_to_json` / `json_agg` (7), `->>` (55), one window function | Various SQL expressions. | Rewritten per call site in the SQLite repositories: `strftime`, `group_concat`, `IN (…)`, `json_object` / `json_group_array`, `->>` (native). Each is covered by the owning repository's parity test. |
| ORDER BY text, locale C (F8) | Byte or code-point order. | SQLite BINARY collation (memcmp of UTF-8) gives the same order. |
| Error codes 23505/23503/23502/23514/22P02 (F17) | Fixed user messages. | Map `SQLITE_CONSTRAINT_UNIQUE`/`FOREIGNKEY`/`NOTNULL`/`CHECK` and type-affinity errors to the same codes in `persistenceErrorMessage`. |
| `pg_dump` snapshots before risky operations (`integrity/snapshot.ts`) | Pre-operation snapshot. | Replaced by the SQLite online-backup snapshot plus verification (R10). |
| Pre-operation `REPEATABLE READ READ ONLY` snapshot for backup | A consistent backup. | `db.backup()` online backup (page-consistent). |

## R8. Schema baseline and migrations (DB-2, DB-9, FR-007/008)

- **Decision**:
  - Build a separate SQLite migration tree, `backend/src/infrastructure/orm/sqlite/migrations/`, whose
    `0000_baseline.sql` reproduces the **effective** PostgreSQL schema at journal idx 99:
    - 53 tables, with columns per R6
    - 53 PKs, 22 UNIQUEs, 45 CHECKs, 73 FKs with identical ON DELETE actions
    - the equivalent indexes (partial indexes kept with `WHERE`; GIN indexes replaced per R7)
    - triggers per R7
  - Later desktop schema changes ship as forward-only SQLite migrations, with their own journal and fingerprint.
  - At boot, the app verifies the SQLite fingerprint, the same way `runDesktopMigrations.ts` does today.
- **Parity check**: a script compares the PostgreSQL fingerprint with the SQLite fingerprint, table by table, column by column,
  constraint by constraint and FK by FK. Allowed deltas are listed explicitly (R6 type mapping, GIN → none, RLS → app predicate).
  Any other delta fails.
- **Clean start**: no import path from PostgreSQL data (DB-8, FR-040).
- **Source of truth**: the live schema obtained by applying all 100 migrations in journal order (fingerprint at idx 99,
  F6b), cross-checked against the Drizzle schemas. It is not the genome's counts and not individual CREATE statements.
- **Historical vs live**: `party_balances` was intentionally dropped by `0038` (F5). It is absent from the live
  reference, so it is not created on SQLite. This is not a schema reduction (C-7): the reference never contains it.
- **Relationships**: the SQLite baseline enforces exactly the **73 live FKs**, with identical columns (including
  composites) and ON DELETE actions. The **24 Drizzle-declared `tenant_id → tenants` references that the live
  database does not enforce** (F6a) are reproduced as they are today: tenant scoping is enforced by repository
  predicates, and **no FK is added**. Adding them would make SQLite reject or cascade operations that PostgreSQL
  accepts, which is a behavior difference (C-1). They are documented as logical relationships in data-model §1.2. Any
  decision to enforce them belongs to a separate change applied to both engines, not to this feature.

## R9. Search (FR-012, spec "Fuzzy/partial text search")

- **Decision**: reproduce the current semantics exactly: case-insensitive *contains* matching for ASCII only, with
  escaped metacharacters, on the same columns as today. That is `LIKE … ESCAPE '\'` on SQLite.
- **Arabic**: today there is no Arabic normalization (F9), so none is added. Hamza and ta-marbuta variants match exactly as they do
  today (Principle IX: no behavior change).
- **Parity test**: a corpus of Arabic, Latin and mixed names, numbers and codes, with `%`, `_` and `\` in queries. Result sets must be identical on both engines.

## R10. Backup v3, verification and restore (BK, RS, FR-041–053, OQ-3/5/6)

- **Decision (format v3, desktop only; cloud keeps v2)**:
  1. Snapshot with `db.backup(tmp)`, then `PRAGMA integrity_check` and `foreign_key_check` on `tmp`.
  2. In `tmp`, remove device-bound state (BK-2, FR-042), followed by `VACUUM`. The existing v2 `DEVICE_BOUND_TABLES`
     (`portableBackup.ts:55-65`) excludes `licenses` entirely, which would drop the company licence identity FR-042
     requires. v3 therefore uses **split** rules, decided from code evidence on 2026-10-03:
     - **Kept, company licence identity**: the `licenses` row (key, type, status, issued/expires, `grace_days`,
       `max_devices`, features, edition, plan, `license_version`, `product_version`, `license_model`, limits,
       transfer/update/backup policies, `transfers_used`, customer fields, `tenant_id`, vendor fields, timestamps).
     - **Nulled in the copy (device-bound columns of `licenses`)**: `binding_type`, `binding_value`, `offline_token`,
       `offline_token_jti`.
     - **Excluded tables (device-bound)**: `license_activations`, `device_registrations`, `secrets`,
       `server_installations`, `revoked_tokens`, `idempotency_keys`, `invitation_codes`, `license_audit_events`.
     - **`license_audit_events` stays excluded**. Every current writer records a device or activation event
       whose payload carries `activationId`, `serverFingerprint` or `deviceId` (`SelfHostedLicenseProvider.ts:158,312,361`,
       `recordDesktopDeviceActivation.ts:151`, `PostgresLicenseRepository.ts:349`). It is the device's
       append-only activation log, not company business data, and its rows reference the excluded activations.
       It is preserved on the device by the restore carry-over rule below.
     - **FK safety in the copy**: `tenants.activation_id` (FK → `license_activations`, ON DELETE SET NULL) is set to
       NULL, matching the FK's own semantics. Any other column referencing an excluded table is handled the same way
       per its live FK action; INVESTIGATE I-18 enumerates them.
     - **Restore carry-over**: before the swap, copy the *live* database's device-bound state into the staging
       copy: the excluded tables, the four nulled `licenses` columns when the licence id matches, and
       `tenants.activation_id`. A same-device restore therefore keeps its activation, binding, secrets and audit log.
       A new-device restore has none, so the licence must be verified on that device (BK-2).
  3. Write a zip containing `database.sqlite`, `files/…` (logos and attachments) and `manifest.json` + `manifest.sha256`. The manifest holds:
     - format `motard-erp-backup`, `formatVersion: 3`
     - app version, schema fingerprint and journal idx
     - tenant id and name, `data_id`
     - per-table row counts and canonical-row sha256
     - file hashes
     - the excluded tables
  4. Write to `<name>.partial`, then `fsync` the file, rename it, and `fsync` the directory.
  5. **Re-open and verify** the final file:
     - zip CRC and manifest hash
     - extract to temp, `integrity_check`, foreign-key check
     - row counts and hashes compared with the manifest

     Only after this passes is the backup recorded as **VERIFIED** in the runtime backup registry
     (`backups.json`, runtime state per DB-3). Otherwise it is recorded as FAILED and the user is told.
  6. The same `createAndVerify()` is used by **every** path: manual, automatic, pre-operation and pre-restore.
     This closes the U-2 mechanisms.
- **Manual download (desktop only)**: the web/cloud app keeps its existing browser download unchanged. The SPA picks
  the path at runtime (Tauri present → native save; otherwise the existing anchor download). On the desktop, the shell saves the verified file through a native save dialog. It confirms the
  written byte size and sha256 before reporting success (U-2 fix). INVESTIGATE I-11: current WebView2
  anchor-download path versus a Tauri save command.
- **Automatic policy (OQ-5)**:
  - Daily: at startup when the newest automatic backup is older than 24 h, and every 24 h while running.
  - Keep the 7 newest.
  - `%LOCALAPPDATA%\motard-erp\backups` plus a mirror under Documents.
  - Pre-operation backups before update, restore, year close/reopen, purge and merge (BK-4).
- **Restore-test (OQ-6)**: weekly, restore the newest automatic backup into a temp directory, then run the RS-5 comparison silently. The result is recorded in
  the registry. A release also requires a manual clean-VM restore.
- **Restore** (RS-3, RS-6):
  1. Verify the backup.
  2. Take an automatic VERIFIED backup of the current state.
  3. Extract into staging.
  4. Forward-migrate the staging copy.
  5. Verify, including the RS-5 comparison against the manifest.
  6. Atomically swap the database file. The previous file is kept aside, never deleted.
  7. Reopen.

  The original archive is opened read-only and never modified.
- **Compatibility (OQ-3)**: `formatVersion 3` from any SQLite-era version restores forward. A v2 (PostgreSQL-era) archive
  is rejected with a clear message.
- **Alternatives considered**: keep v2 NDJSON on SQLite. This would require reimplementing a PostgreSQL-style logical dump and re-import.
  It is slower to restore, and integrity cannot be checked natively. Rejected.

## R11. Installation and data identity (OQ-10, ID-1–8)

- **Decision**:
  - Keep the DPAPI device binding (`device-binding.dat`, per user and PC) as the **installation identity**.
  - Add **data identity inside the database file**: a `motard_meta` table holding `data_id` (minted at creation), `created_by_installation_id`,
    `tenant_id`, `schema_journal_idx`, `app_version_last_opened` and `created_at`. It is mirrored in the `db-meta.json` sidecar.
  - **Open decision table** (applied by the Rust runtime before the backend starts):
    - The sidecar and the in-database `motard_meta` must agree. The device binding must decrypt. `created_by_installation_id` must equal the binding id, or there must be a recorded adoption.
    - All true, **and** the install-instance check (D-1, below) shows the same install or a verified update →
      **REUSE**.
    - Data present but a new installation (new install-instance GUID with no matching update token, or a new or absent
      device binding) → **PRIOR_DATA_FOUND**: Open existing / Restore a backup / Start a new project. Start new
      moves the old data aside, never deletes it.
    - Any mismatch → **MISMATCH**.
    - `integrity_check` fails → **CORRUPT**.
    - No data at all and an empty root → **FRESH**.

    Each state shows its own screen with open, restore or new options. Nothing is deleted automatically (ID-6, C-13).
  - The **connection info** returned by `get_data_root` adds `tenant_id`, company name, database path and `data_id` (ID-7).
- **Update vs new installation (decision D-1, owner-decided 2026-10-03)**: a **new installation** that finds existing
  company data MUST NOT reuse it silently. It must offer **Open existing data / Restore a backup / Start a new project**.
  A **normal application update** reuses the data automatically.

  The DPAPI device binding survives uninstall, so it **cannot** tell these apart. A separate **install-instance identity** is
  therefore added:
  - **Install-instance marker**: `HKCU\Software\MotardFabricsErp\InstallInstanceId` (a GUID).
    - Written by the NSIS `POSTINSTALL` hook only when absent, so an update over an existing install keeps it.
    - Removed by the NSIS `PREUNINSTALL` hook, which already exists and touches only HKCU, never AppData.
    - A fresh install after an uninstall therefore always gets a **new** GUID.
  - **Recorded in data**: `motard_meta.install_instance_id` holds the GUID of the install that last opened the database.
  - **Update hand-off token**: before the in-app updater applies an update, the app writes
    `pending-update.json` (current GUID, from/to version, timestamp) in the data root. This covers the case where the
    updater runs the old uninstaller and the marker is regenerated (INVESTIGATE I-14).
  - **Decision at startup** (all of these also require the device binding to decrypt):
    - marker GUID = `motard_meta.install_instance_id` → **REUSE** (normal restart or update);
    - GUID differs but a valid `pending-update.json` names the recorded GUID and the target version equals the running version →
      **REUSE**, then the record is updated and the token consumed;
    - otherwise → **PRIOR_DATA_FOUND** with the three options.

      **Open existing** records the new GUID in `motard_meta` (an explicit user decision, ID-5). **Restore** follows R10.
      **Start new** moves the existing data to `set-aside\` and never deletes it.
  - A missing or cleared marker (for example a registry cleaner) leads to PRIOR_DATA_FOUND. This is the safe direction: the user is asked, and
    nothing is reused silently or deleted.
- **Backend installation id (decision D-2, owner-decided 2026-10-03)**: on desktop, `InstallationIdStorage` is passed
  the per-user path `%LOCALAPPDATA%\motard-erp\install-id`, seeded from and linked to the device-binding
  `installation_id` (ID-2, FR-069). The cloud keeps its current default (`%ProgramData%\ERP\install-id` / `/var/lib/erp/install-id`).
- **Removed**: `pg_major`, `PG_VERSION`, the pgdata marker, `cluster-identity.txt` (replaced by `data_id`) and `db-port.txt`.

## R12. Locking, single instance and process lifecycle (RT-3–6, OQ-2)

- **Decision**:
  - Keep `tauri_plugin_single_instance`.
  - Add a **data-root lock file**, `motard.lock`, opened with an exclusive Windows share mode by the Rust runtime for its whole lifetime. Its contents are owner PID, process image path, boot id and installation id.
  - On startup, if the lock is held:
    - Read its owner. If the owner is a Motard process of the same installation (image path and installation id match, PID alive), wait,
      then terminate it safely through the existing Job Object or PID-reuse-safe reaper.
    - If the owner is unknown → **LOCKED_UNKNOWN** state. Startup halts, and the database is neither declared corrupt nor replaced.
  - The backend opens the database file only after Rust grants the lock.
  - SQLite's own file locking stays as a second guard.
- **Restart policy (OQ-2)**: the supervisor allows at most 3 backend restarts per rolling 5 minutes. The next failure leads to
  "internal service stopped". The message text never mentions corruption.
- **Removed**: PostgreSQL start/stop, `pg_ctl`, port allocation (`runtime/ports.rs`), stale `postmaster.pid` cleanup and `DATABASE_URL`.

## R13. Sync compatibility (SY-1–7, FR-054–061, OQ-12)

- **Decision**:
  - Device-side sync tables (`sync_outbox`, `sync_state`, `sync_tombstones`, `sync_resource_claims`,
    `document_number_blocks`, `sync_conflicts`, `sync_devices`, and `sync_inbox` if used per I-9) move to SQLite with
    identical columns and state machines.
  - Payloads are built by the unchanged application layer from domain objects, so the wire JSON is
    unchanged by construction, given R5 and R6 at the boundary.
  - **Golden wire test**: the same scenario runs on the PostgreSQL desktop and the SQLite desktop against the same PostgreSQL hub. Captured push batches and
    pull applications are compared as canonical JSON (key-sorted).
- **Restore on a synced device (OQ-12)**:
  - After restore, `sync_state` is marked `restored_snapshot=true` and sync is paused.
  - The device fetches the hub head, then pulls and applies newer units automatically.
  - It opens review mode only if local, not-yet-pushed operations created after the restore conflict with pulled units. These conflicts follow the existing keep-server, rebase and withdraw decisions.
  - The device must never republish old operations: outbox rows already acknowledged by the hub before the backup are marked synced
    from hub state, not re-sent (SY-7).
  - INVESTIGATE I-12: confirm how `verify-restore-sync-state.mjs` and the current outbox ids detect already-acknowledged units.

## R13a. Investigation items added by the 2026-10-03 reconciliation

- **I-14**: does the Tauri v2 NSIS updater (`installMode: "passive"`, `tauri.conf.json:65-71`) run the previous
  version's uninstaller, and therefore `PREUNINSTALL`, during an update? Can the hook detect update mode? The D-1
  design is correct either way, because the update hand-off token covers it. The answer decides whether the token is the
  primary path or the fallback.
- **I-15**: enumerate every operational list path (backend list endpoints, frontend caches, pickers and selectors) for
  parties, invoices, vouchers, returns and orders, and record whether each excludes cancelled records (D-4, FR-017).
- **I-17**: identify every offline time rule in licensing and sync (FR-055, SY-2). Candidates from code are the
  `licenses.grace_days` column (default 7), offline-token expiry (`LicenseTokenSigner.ts`,
  `refreshOfflineEntitlement.ts`) and the `offline_grace_started` audit event. For each rule, record where it is enforced and its effect
  on the PostgreSQL reference after N offline days. The SQLite build must produce the identical effect (C-8). If a rule
  stops ERP operation offline, report it to the owner as a SY-2 conflict. Do not change it silently.
- **I-18**: enumerate every column in a kept table that references an excluded device-bound table (beyond
  `tenants.activation_id`), and its live FK action. These determine the nulling rule in the v3 copy.

## R13b. Phase 2A investigation results (tasks T007–T017, executed 2026-10-03)

Evidence comes from a throwaway PostgreSQL 17.10 test cluster (UTF8, locale C) built from the bundled
`desktop/src-tauri/resources/postgres` binaries and migrated to journal idx 99. It has 53 tables, and the reference suite
is green there: **113 test files / 646 tests pass**.

- **I-13 (T007), RLS on the desktop**: the desktop backend connects as the PostgreSQL **superuser `postgres`**
  (`desktop/src-tauri/src/runtime/stack.rs:53,1273-1275`). Superusers always bypass row-level security, even with FORCE.
  RLS therefore has **no effect on the desktop today**, and isolation rests on repository `tenant_id` predicates plus
  one company per database. SQLite without RLS is behaviorally equivalent. The tenant-isolation suite still guards the predicates.
- **I-15 (T008), cancelled records in operational lists**:
  - **Repositories**: every `list()` (`Postgres{Party,Invoice,Voucher,Return,Order,Expense,Roll}Repository`) filters status
    only when `filter.status` is passed. There is no default exclusion.
  - **Documents** (invoices, receipts, payments, returns, orders, expenses): cancelled rows are shown **labelled
    "ملغاة/ملغى" and greyed or struck through** (`src/routes/{invoices,receipts,payments,returns,orders,expenses}.index.tsx`).
    That is compliant with FR-017, since they are never shown as active, and there is no change.
  - **Parties: non-compliant (D-4).** Cancelled parties appear under "all" with the label "موقوف", the same label as inactive
    (`PartyTable.tsx:87,164,232`). They are also selectable in party pickers fed by the `useParties` cache (sale and purchase
    invoice, order and report pickers).

  The D-4 fix scope is therefore: the party list endpoints (default exclusion), the PartyTable "all" view and the party
  pickers. By-id lookups stay unchanged.
- **I-2 (T009), autonomous writes inside a transaction**:
  - **The one write that matters**: `settleInvoicesUseCase.ts:169` →
    `allocateDocumentNumberForDevice` (`documentNumbers.ts:120-126`, its own `db.transaction`), executed **inside**
    the route's `withTenantTx` (`statement.route.ts:202`). In PostgreSQL the settlement batch number commits on a
    separate pooled connection, so a failed settlement still consumes the number.
  - **Not autonomous**: `statement.route.ts:241` allocates before any transaction (it is outside one), and every other
    allocation uses `allocateDocumentNumber(tx, …)`.
  - **SQLite design (T043)**: join the outer transaction, and register a post-rollback compensation that re-applies the
    counter increment in a fresh transaction. Both engines then consume the number identically. The write gate
    detects any other global-handle write issued while the same async context holds the gate and fails loudly, so
    remaining sites surface in tests.
- **I-4 (T011)**: all 18 Drizzle `date()` columns use the default **string** mode (`'YYYY-MM-DD'`).
- **I-5 (T011)**: no code hashes or compares jsonb column text. The `createHash` sites hash string keys
  (`syncEnqueue.ts:49`, `syncUseCases.ts:2106`), JWK objects, canonical fingerprints or file bytes. jsonb key order
  cannot change results.
- **I-6 (T010)**: the code depends on PostgreSQL's per-transaction `now()`:
  - `PostgresSyncOutboxRepository.ts:86-91` orders by `seq` precisely because units in one transaction share `created_at`;
  - statement keyset cursors compare `(date, created_at, id)` (`PostgresStatementRepository.ts:151,237`).

  So the SQLite **transaction clock is required for ordering parity**. It must also have **microsecond** resolution and be
  strictly increasing across transactions: PostgreSQL `timestamptz` keeps µs, while JS `Date` has only ms, so two
  transactions in the same millisecond would otherwise order differently.
- **I-8 (T012)**: the live function and trigger definitions were exported with `pg_get_functiondef`/`pg_get_triggerdef`
  from the migrated database. They are recorded verbatim in
  [research-appendix-pg-triggers.sql](./research-appendix-pg-triggers.sql), which is authoritative for T035.
  - **Ledger guard**: the remap exception compares every financial column with PostgreSQL NULL semantics (`<>` and
    `IS DISTINCT FROM`). The SQLite trigger must mirror both forms exactly.
  - **Cash-box opening balance**: `cashbox_daily_apply_delta` reads `cashbox_sessions … LIMIT 1` without ORDER BY. This is
    deterministic because the unique index `idx_cashbox_sessions_tenant_currency (tenant_id, currency)` allows at most one row.
  - **Cash-box triggers**: they fire on ledger INSERT and on UPDATE OF status/cash_impact/debit/credit, **never on DELETE**.
- **I-7 (T013)**: `purgeDyeCascade` (`dyePurgeRepository.ts:469-597`) drops the ledger guard, then **only DELETEs**
  ledger rows matching `scopedLedgerPredicate` (invoice and voucher references). It performs no ledger UPDATE, then
  rebuilds the cash-box series with a windowed sum (no trigger fires on DELETE), and recreates the trigger in `finally`.
  The SQLite flag `allow_dye_purge` must permit **DELETE only** and keep UPDATE guarded. The result is identical.
- **I-1 (T014)**: `better-sqlite3` **13.0.3 is an N-API addon** (`node-addon-api`) that ships prebuilds for every platform
  inside the package (`prebuilds/win32-x64.node`, 1,989,632 bytes). There is no install script and no per-Node-version download.
  Verified under the bundled **Node v22.14.0**: SQLite 3.53.4, JSON functions, `RETURNING`, window functions and
  `db.backup` all work. Bundling (T048) follows the argon2 pattern in `desktop/scripts/bundle-server.mjs`: an esbuild
  `external`, plus copying `node_modules/better-sqlite3/{package.json,lib/,prebuilds/win32-x64.node}`.
- **I-16 (T015), non-repository files that touch the database**. The measured counts are queries/transactions per file.
  - **Query files: 25 (move behind ports)**:
    - **Use cases**: `invitationUseCases`, `mergePartiesUseCase`, `recordDesktopDeviceActivation`, `settleInvoicesUseCase`,
      `numberBlockUseCases`, `syncConflicts`, `syncDependencySnapshots`, `syncMaterialize`, `syncNumberCollision`, `syncUseCases`
    - **Infrastructure**: `sessionCutoff`, `TokenDenylist`, `backupScheduler`, `portableBackup`, `linkedDeviceRevocation`,
      `idempotency.middleware`, `ensureServerInstallation`, `detachOrphanBakedLicenses`, `refreshOfflineEntitlement`,
      `SelfHostedLicenseProvider`, `syncTenantLicenseCache`, `documentNumbers`
    - **Routes**: `health.route`, `reports.route`, `search.route`
  - **Transaction-only routes: 19**, which need only the engine facade, plus 7 that issue a single `sql` fragment
    (`backup`, `cashbox`, `color`, `dye`, `fabric`, `party`, `print`). Those 7 are moved behind ports with the query group.
    - Transaction-only: `company`, `expense`, `invoice`, `ledger`, `order`, `return`, `settings`, `statement`, `voucher`,
      `year-closing`
    - Mixed: `cashbox`, `color`, `dye`, `fabric`, `party`, `print`
  - **Wiring only (no queries)**: `purgePartyCascadeUseCase` (5 tx), `setupUseCases`, `di/container`, `server.ts`,
    `ports/IStockMovementRepository` (type import only).
- **I-17 (T016), offline time rules**: there are none tied to being offline.
  - The desktop's baked licence has `expiresAt: null` and a signed offline token valid for **100 years**
    (`scripts/bake-desktop-license.ts:37,89,124`).
  - `grace_days` (default 7) applies only after a licence's calendar `expiresAt` (`graceRemainingDaysFor`,
    `license.guard.middleware.ts:38-42`), not after a period offline.
  - The heartbeat reports remaining token days (`license.heartbeat.middleware.ts:116`).

  All of these are application-level date arithmetic, so they are engine-independent and there is **no SY-2 conflict**.
- **I-18 (T017)**: kept tables with FKs into excluded device-bound tables:
  - `tenants.activation_id → license_activations` (SET NULL, nullable);
  - **`sync_devices.device_registration_id → device_registrations` (NO ACTION, nullable)**. This one was added to
    `nulledColumns` in `contracts/backup-format-v3.md`.

  The 12 FKs that originate *from* excluded tables disappear with those tables.
- **I-9 (T105), does a desktop write `sync_inbox`?** **Yes.** `runLocalSyncPull` (`syncUseCases.ts` ~880–1000)
  mirrors every pulled unit into the device's own `sync_inbox` before applying it. The calls are `inbox.receive` with
  `syncDeviceId: null`, because the origin device is a peer that is registered only on the hub; then `markApplied`
  after the apply, or `markDead` after bounded retries. The mirror carries `apply_attempts`, so a unit that can never
  apply is parked instead of freezing the pull cursor. Consequences for SQLite:
  - the `sync_inbox` table and trigger **T7** (`trg_sync_inbox_applied_seq_ai/_au`, baseline migration) are required
    on the desktop, not only on the hub;
  - the shared advisory lock that PG takes in `listAppliedSince` is unnecessary, because the single writer makes
    commit order equal `applied_seq` order;
  - `GET /sync/pull` (`listAppliedSince`) is a hub-side read, which the PG hub keeps unchanged.
- **I-12 (T105), how acknowledged outbox units are identified after a restore.** By **`op_id`**. Each outbox unit
  gets its op-id at enqueue time (`enqueueInvoiceCreate` and the others: `randomUUID()` unless a valid one was
  supplied), and the backup stores it with the row. The hub's `sync_inbox` is unique on `(tenant_id, op_id)`, so a
  repeated push hits `receiveSyncPush` → `inbox.receive(...).created === false`. An `applied` row answers
  `accepted/terminal` with no second business effect. A `rejected` row answers with the stored conflict. Any other
  row only retries materialization. `verify-restore-sync-state.mjs` part C proves this on PG: a unit restored as
  `applied` is not re-pushed; a unit restored as `pending` that the hub already holds is accepted with no duplicate
  invoice, ledger or party; a unit stranded as `pushing` is reclaimed after its lease. The ack check is therefore
  "the hub already holds this op-id", and it does not depend on the engine. SY-7 is met in T109 without asking the hub (owner decision 2026-10-05, option b): the restored device
  takes a new sync identity, so the hub returns its earlier units as peer units, and every pulled op-id found in the
  restored outbox is acknowledged instead of pushed (`syncRestoreUseCases.ts`).
- **I-5 for sync (T108):** re-checked against the sync paths. No code hashes or compares jsonb *payload text*.
  `syncEnqueue.ts` and `syncUseCases.ts` hash string keys only, and both the push and pull bodies are parsed JSON. Key
  order therefore cannot change a sync result, and `helpers/jsonCanonical.ts` is **not needed**. The golden wire test
  (T103) compares with sorted keys, so any future key-order dependency would show up there.

## R13c. Findings during implementation that need an owner decision

- **O-1 — `GET /parties/by-ids` and `GET /rolls/by-ids` always fail (pre-existing, found 2026-10-03, T029).**
  - **Cause**: `ANY(${ids}::uuid[])` lets Drizzle expand the JS array into a record. PostgreSQL rejects it with
    "malformed array literal" for one id and "cannot cast type record to uuid[]" for more.
  - **Effect**: `src/components/vouchers/PartyCombobox.tsx:56` swallows the error, so a voucher form opened with a preselected party
    and no `valueLabel` shows no party name.
  - **Decision needed**: fixing it changes shared and cloud behavior and is not among the approved pre-reference fixes
    (constitution v1.1.0 allows only D-3, D-4 and Track P), so it has **not** been fixed.
  - **Locking test**: the current behavior is locked by `backend/tests/search-repository.test.ts`.
  - **Options**: approve it as an additional pre-reference fix, applied to both engines before the reference is
    re-frozen; or keep the SQLite implementation failing identically.
- **Measurement correction (T015 → T029)**: five of the seven "single-fragment" routes matched only Express's
  `router.delete(...)`, not a database delete. Only `print.route.ts` had a real query, now behind
  `IPrintJobRepository.rollNoOf`.
- **CHECK-constraint text (affects T036)**: `schema-fingerprint.json` lower-cases constraint definitions (it shows
  `'syp'`), while the live constraint accepts the stored `'SYP'`. The SQLite CHECK constraints must be generated from live
  `pg_get_constraintdef()` output, never from the fingerprint text.

## R13d. S2 column-type results (T032–T033, 2026-10-03)

Implemented in `backend/src/infrastructure/orm/sqlite/{types,clock,exactIntegers}.ts`; proven against live PG 17 by
`backend/tests/sqlite/decimal-types.test.ts` (700,000 values) and `backend/tests/sqlite/column-types.test.ts`.

- **Live numeric scales differ from the T032 list.** The fingerprint has (14,2) ×41, (12,2) ×15, (18,6) ×5 (all
  `exchange_rate`), (7,2) ×4, (14,4) ×3, (5,4) ×2 and (14,3) ×1. There is no (6,2). The live set is implemented and tested.
- **Two read modes.** Drizzle `numeric(..., mode: "number")` returns `Number(pgText)`, while bare `decimal(...)` returns
  PG's fixed-scale text (`"12.50"`). The SQLite types provide `numeric` and `decimalString` for the two modes.
  Both format the scaled integer to PG text first, so every read equals PG bit-for-bit.
- **Types not in data-model §2**: `text[]` ×3 and `uuid[]` ×1 are stored as JSON-array TEXT and read back as `string[]`.
  `inet` ×1 (`audit_logs.ip_address`) is stored in PG's `inet_out` canonical form (BIND IPv6 compression, host mask omitted).
- **Exact int64 reads.** better-sqlite3 returns INTEGER as a double, which lost digits of (18,6) values above
  ~9.007e9. `withExactIntegers` runs statements in safe-integer mode and turns every value inside ±2^53 back into a
  `number`, so nothing else changes. The connection layer (T041) must use it.
- **Allowed delta — SUM overflow.** SQLite's integer `SUM` raises `integer overflow` once a running total leaves
  ±2^63 scaled units. That is ≥ 9.2×10^16 at scale 2 and ≥ 9.2×10^12 at scale 6. PG's sum keeps going. It is an error,
  never a wrong value, and the test asserts both behaviors.
- **Allowed delta — NaN.** PG stores `NaN` in numeric(p,s); the SQLite type refuses it (22P02). NaN money is always an
  upstream defect.
- **Rejections carry PG SQLSTATEs and messages**: 22003 overflow, 22P02 syntax, 22007/22008 date, 22P05 jsonb `\u0000`.
  The T047 error mapping can treat them exactly like PG errors.
- **jsonb** text is stored in PG key order (length, then bytes). Parsed values are identical on both engines.
- **Timestamps** are written like Drizzle-PG (`toISOString()`, padded to µs) and read with `new Date(text)`. V8 truncates
  µs identically for both text forms. `now()` defaults come from the transaction clock (`clock.ts`, the primitive that
  T042 binds at BEGIN).

**S2 schema results (T034–T040)**:
- **Generated, not hand-written.** `scripts/generate-sqlite-schema.mts` writes the Drizzle definitions; `--check`
  detects drift. They mirror the 50 PG Drizzle tables with the same exports and keys, plus the 3 raw-SQL-only tables.
  A compile-time test (`tests/sqlite/schema-type-parity.test.ts`, run by `npm run typecheck:sqlite`) proves that
  `$inferSelect` and `$inferInsert` are identical. The live-only column `sync_inbox.tombstone_id` is in the DDL only,
  so `select()` shapes stay identical to PG.
- **DDL from the live catalog.** `scripts/generate-sqlite-baseline.mjs` reads `pg_get_constraintdef` and
  `pg_get_indexdef` and writes `0000_baseline.sql`: 53 STRICT tables, 53 PK, 22 UNIQUE, 45 CHECK and 73 FK under
  their PG names, and 126 btree indexes. The 12 GIN indexes are omitted.
- **Serials.** The 3 serial PKs are `INTEGER PRIMARY KEY AUTOINCREMENT`. `sync_outbox.seq` and
  `sync_inbox.received_seq` are not PKs; their values come from `motard_sequences` through `sqlite/sequences.ts`
  (Drizzle `$defaultFn`). They have no SQL DEFAULT, so a raw insert that omits them fails NOT NULL loudly.
  Allowed delta: a value consumed by a rolled-back insert is reused.
- **Design correction — no app-defined functions in the schema.** better-sqlite3 cannot register SQLITE_INNOCUOUS
  functions, so under the planned `trusted_schema=OFF` (T041) any schema use fails with "unsafe use of …". Main-schema
  triggers also cannot read TEMP tables (verified). The transaction clock and the session flags therefore live in the
  runtime table `motard_tx_state` (data-model §3), and DDL timestamp defaults fall back to built-in `strftime`
  wall time. Drizzle and the SQLite repositories always bind the transaction clock explicitly. The schema is
  self-contained and opens in any SQLite tool.
- **Triggers T1–T7 → 11 SQLite triggers.** The ledger guard keeps PG's message order through sequential
  `SELECT RAISE … WHERE` statements, and its remap bypass keeps plpgsql NULL semantics. `tests/sqlite/triggers.test.ts`
  replays the same 400 seeded operations on PG and SQLite: `cashbox_daily_balances` is identical row for row, the
  per-operation outcomes and messages are identical, and a mutated trigger is caught (negative control).
  `applied_seq` is strictly increasing in commit order.

**S3 connection layer (T041–T048)**:
- **Write gate.** One writer connection and one read-only reader. The FIFO gate is unbounded (tested with 1,000 queued
  writers). The layer owns `BEGIN IMMEDIATE`/`COMMIT` because Drizzle's native SQLite transaction cannot span an
  `await`. Nesting uses savepoints, and a nested transaction for another tenant is refused as on PG. A write builder
  created outside a transaction but executed inside one fails with `SQLITE_GATE_REENTRY` instead of deadlocking.
- **T043 per-site decisions (I-2).** The primitive `runAutonomous` joins the outer transaction and is replayed in a
  fresh transaction after a ROLLBACK. Proven by `tests/sqlite/connection.test.ts`: a failed settlement still consumes
  its number, as on PG.
  - `allocateDocumentNumberForDevice` inside the settle `withTenantTx` → `runAutonomous` (counter consumed as on PG).
  - `syncConflicts` conflict rows, `syncMaterialize` tombstones and the user upsert, and `syncDependencySnapshots`
    (`pool.query` on PG, committed regardless of the caller) → `runAutonomous` in the SQLite stores.
  - A nested `runInTransaction` that PG would run on another pooled connection → joins as a savepoint (single writer).
  - Open: the per-call-site tests in `tests/sqlite/autonomous-writes.test.ts` land with the SQLite stores that own
    these sites (T059 settle, T107 sync).
- **Error shape (T044).** The statement wrapper converts every SQLite error to the PG SQLSTATE, constraint name and
  message, so `persistenceErrorMessage` and every other consumer are unchanged. For FK failures the constraint name
  is recovered by replaying the statement in a savepoint with deferred FKs and reading `foreign_key_check`.
- **Boot (T045).** FRESH builds the file as `motard.db.creating` and renames it into place after COMMIT. Any other
  state opens an existing file only, and boot refuses a foreign `data_id`, a newer schema or a fingerprint mismatch.
  Pending migrations are applied forward only, after a `VACUUM INTO` snapshot. New runtime env: `MOTARD_STARTUP_STATE`
  and `MOTARD_INSTALL_INSTANCE_ID` (contract updated). The boot integrity manifest (REPAIR-023/026) runs on SQLite
  through the reader.
- **Packaging (T048).** The bundle carries `node_modules/better-sqlite3/{package.json,lib,prebuilds/win32-x64.node}` and
  `sqlite-migrations/`. The folder resolver accepts only a journal with `dialect: "sqlite"`, because the bundle also
  ships the PG `migrations/`. Verified with the bundled Node v22.14.0. `server-bundle.test.mjs` boots a PostgreSQL
  template and was deferred while the machine was low on memory.

## R14. Test strategy (AC-3, AC-8, AC-9, SC-001–012)

- **Decision**: three layers.
  1. **Engine conformance**: the existing backend integration tests (113) are parameterized by `DB_ENGINE`.
     The PostgreSQL run stays the reference, and each SQLite repository must pass the same tests.
  2. **Behavioral parity harness**: drives the HTTP API with identical scripted scenarios on the PostgreSQL desktop
     build and on the SQLite build, each from a clean state. It exports:
     - API outputs: statements, balances, reports, lists
     - a canonical business-table snapshot, with IDs mapped through natural keys and creation order, timestamps normalized and money compared exactly

     The diff must be empty. Scenarios cover the AC-3 list, SYP/USD/EUR, rounding edge cases (`x.xx5`) and concurrency on the same roll and number.
  3. **Lifecycle and EXE**: the §10.1 protocol on Windows 10 22H2 and Windows 11 VMs, crash/kill/hard-reset durability,
     backup and restore including corruption injection, A/B sync, and volume (100k gate, 1M soak).
- **Rationale**: layer 1 catches dialect bugs early and cheaply. Layer 2 is the AC-3 proof. Layer 3 is the only layer that satisfies the gates
  (§10: unit tests alone never pass a gate).

## R14a. Cancelled records in operational lists (decision D-4, owner-decided 2026-10-03)

- **Decision**: cancelled customers and suppliers MUST NOT appear in normal operational lists, **including the default
  "all" view**. They remain stored unchanged and reachable for audit and history. The current PostgreSQL behavior,
  where the list returns cancelled parties by default and `PartyTable.tsx` shows them under "all", is the **P-5 defect**. It is **not** the parity reference.
- **Scope of the fix** (shared code, so both engines behave identically):
  - **Backend list endpoints**: exclude `status = 'cancelled'` by default. This covers `PostgresPartyRepository.list`, its SQLite twin, and the route schema in `party.schema.ts`.
  - **Frontend operational lists**: the party table, pickers and the cached party lists used for selection exclude cancelled parties.
- **Must keep working**:
  - lookups **by id** for historical documents (an old invoice still shows its cancelled customer's name);
  - statements and audit views;
  - purge and merge impact checks.

  The fix filters lists, not lookups.
- **Parity reference**: the fix lands on the PostgreSQL build in stage S0, **before** the reference is frozen. Both
  engines are then compared on the corrected behavior. The parity scenarios include an explicit check that a cancelled party is
  absent from every operational list and still present in history.
- **Same class for other entities** (FR-017): stage S0 also audits every list path for invoices, vouchers,
  returns and orders against the same rule. INVESTIGATE I-15 enumerates them. Any additional defect found is fixed the
  same way before the reference is frozen, and listed in the S0 report.

## R15. Pagination track (OQ-11)

- **Decision**: run it as a **separate feature (track P)**, outside this spec's implementation, landing before SQLite acceptance.
  Its scope:
  - the `useStatement.ts:53` 1000-page bound
  - the `fetchAllPaged` `maxPages` throw, and its callers' silent catches (party and inventory caches)
  - the list error state with Retry instead of an empty list (decision D-3, FR-068)

  Track P is verified on PostgreSQL first, and the AC-9 baseline is re-taken afterwards. Together with D-4, track P is an
  **approved pre-reference defect fix** (FR-070). These are the only permitted behavior changes to shared or cloud code
  paths, and they are applied before the parity reference is frozen. This feature consumes its result. It does not merge its code.
- **Recommendation**: create it with `/speckit-specify` as `002-history-completeness`.
