# Phase 1 Data Model: Desktop Local Database Replacement

**Feature**: `001-desktop-sqlite-engine` | **Date**: 2026-10-03 | **Research**: [research.md](./research.md)

This document fixes **what** the SQLite desktop database must contain. The authority is the effective
PostgreSQL schema recorded in
`backend/src/infrastructure/orm/migrations/meta/schema-fingerprint.json` (journal idx 99), not
`ERP_GENOME.md` alone (see the discrepancy in §1).

## 1. Schema inventory (parity target)

| Object | PostgreSQL reference | SQLite target | Allowed delta |
|---|---|---|---|
| Tables | 53 | 53 + `motard_meta` + `motard_sequences` + `motard_tx_state` | 3 new persistent runtime tables (DB-3) |
| Primary keys | 53 | 53 | none |
| UNIQUE | 22 | 22 | none |
| CHECK | 45 | 45 + generated length/JSON/boolean checks | added checks only reproduce existing PostgreSQL type rejection |
| Foreign keys | 73 enforced (63 NO ACTION, 8 CASCADE, 2 SET NULL; 0 deferrable), incl. composite FKs | 73, same columns and actions | none. The 24 non-enforced Drizzle declarations stay non-enforced (§1.2). |
| Indexes | 213 (30 partial/expression/GIN) | all B-tree and partial indexes kept | trigram GIN → none or FTS5 prefilter (research R7/R9) |
| Triggers | 7 | 7 equivalents + 1 flag-aware variant for the ledger guard | see §4 |
| RLS policies | 49 | none | replaced by app-level `tenant_id` predicates + isolation test (R7) |
| Extensions | `pg_trgm`, `plpgsql`, `uuid-ossp` | none | functions replaced per R7 |

### 1.0 Reconciled schema history (from all 100 migrations in journal order; research F5–F6b)

| Category | Count | Tables / notes |
|---|---|---|
| Tables ever created | 54 | — |
| **Intentionally dropped** | 1 | `party_balances`: created `0020`, dropped `0038_drop_party_balances.sql`. Unused cache. **Not created on SQLite** (absent from the live reference; not a C-7 reduction). |
| Renamed | 0 | — |
| **Currently live** | **53** | 50 defined in Drizzle + 3 raw-SQL-only (`financial_operations`, `sync_conflicts`, `sync_tombstones`) |
| Live but unused at runtime | 1 | `ledger_entry_archive` (OQ-7). Kept. |

| Relationships | Count | Treatment on SQLite |
|---|---|---|
| Drizzle `.references()` declarations (the source of the genome's "86") | 86 | informational only |
| **Live enforced FK constraints** | **73** | **reproduced exactly** (columns incl. composites, ON DELETE actions) |
| ├ declared in Drizzle and live | 62 | enforced |
| └ live, raw-SQL only | 11 | enforced |
| **Declared in Drizzle, never enforced in the database** | 24 | `tenant_id → tenants` on core business tables (list in research F6a). **Not added as FKs** (adding them would change behavior vs the reference). Enforced as today by tenant predicates (§1.2). |

`ERP_GENOME.md` (54 tables / 86 relationships) is superseded for counting purposes by this table. It remains
the navigation map only.

### 1.1 Tables by domain (53)

- **Tenancy and people**: `tenants`, `users`, `company_profiles`, `settings`, `system_admins`
- **Parties**: `parties`, `yearly_party_summaries`
- **Documents**:
  - sales and purchases: `invoices`, `invoice_lines`, `returns`, `return_lines`, `orders`, `order_items`
  - money and printing: `vouchers`, `expenses`, `print_jobs`, `financial_operations`
- **Ledger**: `ledger_entries`, `ledger_entry_archive` (kept; unused per OQ-7)
- **Inventory**: `fabrics`, `colors`, `rolls`, `stock_movements`, `inventory_counts`
- **Cash box**: `cashbox_sessions`, `manual_movements`, `cashbox_daily_balances`, `day_closes`
- **Years**: `financial_years`
- **Numbering**: `document_sequences`, `document_number_blocks`
- **Sync**: `sync_devices`, `sync_device_authorized_users`, `sync_outbox`, `sync_inbox`, `sync_tombstones`,
  `sync_resource_claims`, `sync_conflicts`, `sync_state`
- **Licensing and installation**: `licenses`, `license_activations`, `license_audit_events`, `device_registrations`,
  `invitation_codes`, `server_installations`, `secrets`, `setup_wizard_state`, `revoked_tokens`
- **Support**: `attachments`, `audit_logs`, `notifications`, `idempotency_keys`, `schema_migrations`

### 1.2 Logical (non-enforced) relationships

The 24 `tenant_id → tenants` references in research F6a are real business relationships: every row belongs
to its tenant. In the live PostgreSQL schema they are enforced by RLS policies and repository predicates, not by FKs.
On SQLite they are enforced by repository predicates and verified by the tenant-isolation suite
([contracts/db-engine-port.md](./contracts/db-engine-port.md) guarantee 3). The FK parity check treats their absence as
**expected**. Adding one is a failure, because it diverges from the reference.

## 2. Column type mapping

| PostgreSQL type (count) | SQLite column | Read type in JS | Write rule |
|---|---|---|---|
| `numeric(14,2)` (most money) | `INTEGER` ×10² | `number` | shortest-decimal string → round half away from zero → integer |
| `numeric(14,3)`, `numeric(14,4)`, `numeric(6,2)`, `numeric(5,4)` | `INTEGER` ×10^scale | `number` | same rule, with the column's scale |
| `numeric(18,6)` (exchange rates and similar) | `INTEGER` ×10⁶, BigInt-safe | `number` (as today) | same rule |
| `uuid` (193) | `TEXT` canonical lower-case | `string` | `randomUUID()` default |
| `timestamptz` (107) | `TEXT` fixed-width ISO UTC, µs | `Date` | default = transaction clock (R6) |
| `date` (18) | `TEXT` `YYYY-MM-DD` | as today (I-4) | validated format |
| `boolean` (7) | `INTEGER` CHECK IN (0,1) | `boolean` | — |
| `jsonb` (33) | `TEXT` CHECK `json_valid` | parsed object | serialized at boundary (I-5) |
| `integer` / `bigint` / `serial` / `bigserial` | `INTEGER` (AUTOINCREMENT for serials) | `number` / `bigint` as today | — |
| `varchar(n)` (198) / `text` (48) | `TEXT` (+ `CHECK length <= n`) | `string` | — |

## 3. New runtime entities (DB-3, ID-1–7)

### `motard_meta` (single row, inside the database file)

| Field | Meaning | Rules |
|---|---|---|
| `data_id` | Identity of this company database | Minted once at creation. Never changes. Copied unchanged into backups. |
| `created_by_installation_id` | Device-binding id that created it | Compared at open (R11) |
| `adopted_installation_ids` | Installations explicitly allowed to open it | Appended only on an explicit user "open existing" choice or a restore |
| `install_instance_id` | GUID of the install (HKCU marker) that last opened it (D-1) | Equal to the current marker → same install. Updated only by a verified update hand-off or an explicit "Open existing". |
| `tenant_id` | The single company in this file | Shown in connection info (ID-7) |
| `schema_journal_idx` | SQLite migration level | Newer than the binary supports → refuse to open (no down-migration) |
| `app_version_last_opened` | Last app version that opened the file | Diagnostics |
| `created_at` | — | — |
| `restored_from` | Backup `data_id` + manifest hash, if restored | Drives SY-6 |

### `motard_sequences`

Replaces PostgreSQL sequences used by triggers: `name`, `value`. It is incremented inside the writing
transaction, which is safe because writers are serialized.

### `motard_tx_state` (replaces the planned TEMP `motard_session_flags`; research R13d)

A single row (`id = 1`) holding the transaction clock `ts` and the per-transaction flags `allow_party_remap` and
`allow_dye_purge`. These replace PostgreSQL `now()` inside triggers and the `set_config` GUCs. The writer stamps `ts`
at BEGIN and resets both flags before COMMIT; a rollback discards any change. A TEMP table is impossible, because
main-schema triggers cannot reference TEMP tables. App-defined functions are also impossible: better-sqlite3 cannot
mark them innocuous, and `trusted_schema=OFF` forbids them in schema objects. A missing row reads as flags 0,
so the guard fails closed.

### Sidecar files in `%LOCALAPPDATA%\motard-erp\` (runtime state, not company data)

| File | Content | Replaces |
|---|---|---|
| `device-binding.dat` | DPAPI blob: installation id + fingerprint | unchanged |
| `db-meta.json` | mirror of `data_id`, `tenant_id`, `schema_journal_idx`, `installation_id` | old `db-meta.json` (`pg_major` removed) |
| `motard.lock` | owner PID, image path, boot id, installation id | `postmaster.pid` / port file |
| `backups.json` | backup registry: path, kind, created, status VERIFIED/FAILED, manifest hash, last restore-test | none (new; BK-7) |
| `install-id` | backend licence installation id (desktop, per user; decision D-2) | `%ProgramData%\ERP\install-id` |
| `pending-update.json` | update hand-off token: install-instance GUID, from/to version, timestamp (D-1) | none (new); consumed on the first successful post-update open |
| registry `HKCU\Software\MotardFabricsErp\InstallInstanceId` | install-instance GUID. Written by the installer if absent; removed by the uninstaller (D-1). | none (new) |
| `data\motard.db` (+ `-wal`, `-shm`) | the company database | `pgdata\` |

Removed: `pgdata\`, `db-port.txt`, `cluster-identity.txt`, `fresh-install.pending` (replaced by the
FRESH state rule), `.motard-cluster-identity`, `.motard-scram-pw-set`.

## 4. Trigger equivalents

| # | Reference trigger | SQLite form | Parity check |
|---|---|---|---|
| T1 | `trg_ledger_entries_append_only` (BEFORE UPDATE OR DELETE) | `BEFORE DELETE` + `BEFORE UPDATE` with `RAISE(ABORT, msg)`. Same predicates: delete forbidden; update only `status→cancelled`; financial columns immutable. Bypass when `allow_party_remap` (party_id only) or `allow_dye_purge` is set. | attempted forbidden mutations fail with the same mapped error on both engines |
| T2 | `cashbox_daily_ledger_ai` (AFTER INSERT ledger) | `AFTER INSERT` → apply delta (UPSERT the day, then shift later days) | `cashbox_daily_balances` identical row-for-row after every scenario |
| T3 | `cashbox_daily_ledger_au` (AFTER UPDATE OF status, cash_impact, debit, credit) | `AFTER UPDATE OF …` → reverse old, apply new | same |
| T4 | `cashbox_daily_manual_aiud` | three triggers: `AFTER INSERT` / `UPDATE` / `DELETE` on `manual_movements` | same |
| T5 | `trg_license_audit_events_no_update` | `BEFORE UPDATE` `RAISE(ABORT)` | same error |
| T6 | `trg_license_audit_events_no_delete` | `BEFORE DELETE` `RAISE(ABORT)` | same error |
| T7 | `trg_sync_inbox_applied_seq` | `AFTER INSERT` / `AFTER UPDATE OF status`: set `applied_seq` from `motard_sequences` when status becomes `applied`, and `applied_at` if null | only if the desktop writes `sync_inbox` (I-9); otherwise kept for schema parity |

The function bodies (`cashbox_daily_apply_delta`, `cashbox_daily_shift_all`, the latest
`fn_ledger_entries_append_only` from `20261011_ledger_party_remap.sql`) are transcribed exactly during
stage S2 (I-8). This plan does not paraphrase them.

## 5. State machines

### 5.1 Startup data state (Rust runtime, before the backend opens the database)

```text
              ┌───────────────┐ lock held by same install → wait / safe terminate → retry
   start ───► │ acquire lock  │─ lock held by unknown ─────────────► LOCKED_UNKNOWN (halt, no change)
              └──────┬────────┘
                     ▼
        data root empty & no binding-era evidence ───────────────► FRESH → create db, mint data_id
        db present + sidecar/meta agree + binding matches
          + install-instance GUID = motard_meta.install_instance_id
            (or a valid update hand-off token) ──────────────────► REUSE → open   (normal restart / update)
        db present + new installation (new GUID without a token,
          or binding new/absent) ────────────────────────────────► PRIOR_DATA_FOUND → user: open existing | restore a backup | start new project (old moved aside)
        sidecar ≠ meta, or tenant/installation mismatch ─────────► MISMATCH → user: restore | open read-only diagnostics | start new (aside)
        integrity_check fails / not a SQLite file ───────────────► CORRUPT → user: restore | start new (aside)
        schema_journal_idx newer than binary ────────────────────► TOO_NEW → user: install newer version (no change)
        db missing but evidence of prior data ───────────────────► DATA_MISSING → user: restore | locate | start new
```

No transition deletes, overwrites or silently creates a database (C-13). "Aside" means the data is renamed into
`%LOCALAPPDATA%\motard-erp\set-aside\<timestamp>\`.

### 5.1a Device-bound state in backups (BK-2, FR-042)

| Kind | Items | In backup |
|---|---|---|
| Company licence identity | `licenses` row (all columns except the four below) | **kept** |
| Device-bound columns | `licenses.binding_type`, `licenses.binding_value`, `licenses.offline_token`, `licenses.offline_token_jti`, `tenants.activation_id` | **nulled** in the copy, carried over from the live database on restore |
| Device-bound tables | `license_activations`, `device_registrations`, `secrets`, `server_installations`, `revoked_tokens`, `idempotency_keys`, `invitation_codes`, `license_audit_events` (the device activation log; see research R10 evidence) | **excluded**, carried over from the live database on restore |

### 5.2 Backup record

`CREATING → WRITTEN(.partial) → FLUSHED → RENAMED → VERIFYING → VERIFIED | FAILED`

Only `VERIFIED` counts as a backup in the UI, in retention ("keep 7") and in `lastSuccessfulBackupAt`.

### 5.3 Restore

`VERIFY_ARCHIVE → SAFETY_BACKUP(VERIFIED) → EXTRACT_STAGING → MIGRATE_STAGING → VERIFY_STAGING (RS-5) → CARRY_OVER_DEVICE_STATE (live excluded tables + nulled licence/tenant columns → staging) → SWAP (old kept aside) → REOPEN → [synced device] SYNC_PAUSED → RECONCILE → SYNC_RESUMED`

Failure at any step before SWAP leaves the live database untouched.

### 5.4 Backend supervision

`RUNNING → CRASHED → RESTARTING (n ≤ 3 in rolling 5 min) → RUNNING | STOPPED("internal service stopped")`
