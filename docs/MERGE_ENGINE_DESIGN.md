# Smart Merge (Reconciliation) Engine Design

**Subject:** Smart Non-Destructive Merge Restore — architectural design document
**Status:** DESIGN ONLY — no merge code and no merge schema change exists (verified 2026-10-21; nothing
of it ships in 3.0.7)
**Parent document:** `docs/GOOGLE_DRIVE_AND_SMART_BACKUP_PLAN.md` §5 (superseded by this document)
**Scope:** SQLite ERP architecture — desktop engine only (PostgreSQL twin per CLAUDE.md two-engine rule)
**Audited against:** Independent Forensic Audit findings (G-01 through G-13, B-01 through B-05)

---

## 0. Ground Truth — What the Schema Actually Supports

Every design decision below traces to verified schema evidence. Where the previous plan assumed behavior the schema does not provide, the assumption is retired and replaced.

### 0.1 What already exists (verified against schema)

| Invariant                                                           | Mechanism                                                                                                                                   | Location                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ledger_entries` append-only                                        | `BEFORE UPDATE OR DELETE` trigger raising on any change except `status → 'cancelled'` via `allow_party_remap` escape hatch                  | `0000_baseline.sql` triggers, `0013_db_hardening.sql`, `0036b_ledger_append_only.sql` |
| `ledger_entries` natural dedup key                                  | `client_operation_id` (uuid, nullable) with partial unique index `uq_ledger_entries_tenant_client_op WHERE client_operation_id IS NOT NULL` | `ledger-entry.table.ts:48`, `0000_baseline.sql:1544`                                  |
| Party balance derived at read                                       | No `parties.balance` column; `party_balances` table dropped in `0038_drop_party_balances.sql`                                               | `party.table.ts`, `SqliteLedgerRepository.ts:263-287`                                 |
| `rolls.remaining_kg` stored counter + `stock_movements` audit trail | `remaining_kg` + `balance_after_kg` snapshot per movement                                                                                   | `roll.table.ts`, `stock-movement.table.ts`                                            |
| `rolls.remaining_pieces` stored counter, **NO audit trail**         | No pieces column anywhere except `rolls.remaining_pieces`                                                                                   | `roll.table.ts`, `stock-movement.table.ts`                                            |
| `cashbox_daily_balances.closing_balance` stored cumulative series   | Maintained incrementally by `cashbox_daily_ledger_ai` trigger (delta + shift-all-later-days)                                                | `20260928_cashbox_daily_balances.sql`, `0000_baseline.sql:1689-1711`                  |
| `invoices.paid` stored scalar                                       | Maintained by app code; drifts from vouchers by construction                                                                                | `invoice.table.ts:45`, `SqliteInvoiceRepository.ts:401`                               |
| `UNIQUE(tenant_id, type, number)`                                   | invoices, vouchers, returns                                                                                                                 | `0000_baseline.sql:479, 1460, 944`                                                    |
| Period lock is application-level only                               | `assertDayUnlocked` / `assertYearOpen` in `dayLockHelper.ts`; no DB trigger rejects old dates                                               | `dayLockHelper.ts:26-80`                                                              |
| `writeMany` has no period guard                                     | `SqliteLedgerRepository.writeMany` inserts arbitrary dates with no day/year check                                                           | `SqliteLedgerRepository.ts:141-165`                                                   |
| `rebuildCashboxSeries` already exists                               | DELETE series + `sum(daily_delta) OVER (...)` rewrite                                                                                       | `dyePurgeRepository.ts:390-445`                                                       |
| `recomputeCashboxBalanceAsOf` already exists                        | Read-only full recompute as fallback                                                                                                        | `cashboxBalanceHelper.ts:22`                                                          |
| `hubFingerprint` already exists                                     | Hashes ledger balances + roll stock per tenant                                                                                              | `hubFingerprint.ts:100-117`                                                           |

### 0.2 What the schema does NOT support (verified gaps)

| Gap                                                           | Consequence                                                     | Design response                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `stock_movements` has no `client_operation_id`                | Stock movements cannot be idempotently re-inserted              | **Task 4.5:** Add `client_operation_id` + partial unique index                          |
| `stock_movements` has no `pieces_delta`                       | `rolls.remaining_pieces` cannot be reconstructed from movements | **Task 4.5:** Add `pieces_delta` column                                                 |
| `ledger_entries.client_operation_id` is nullable              | Legacy rows may lack it; merged rows must always set it         | **Task 4.4:** Document that all merged rows set `client_operation_id` deterministically |
| No DB-level period lock                                       | Old-dated inserts are never rejected at the DB layer            | **Task 4.8:** Pre-apply refusal gate in planner + re-check in transaction               |
| `invoices.paid` drifts from vouchers by construction          | I-3 cannot be a hard gate                                       | **Task 4.6:** Downgrade to diagnostic with tolerance                                    |
| No cross-invariant between invoice header and its ledger legs | I-1/I-2 pass while books are wrong                              | **Task 4.9:** Add I-10 (per-invoice ledger-vs-header agreement)                         |

---

## 1. Architectural Principles

1. **Read-only planning.** The planner runs against a **staged copy** of the backup database opened `readonly: true`. The live database is never written during planning. This is enforced with `PRAGMA query_only` on the live connection.
2. **Single transaction apply.** The applier runs in one `BEGIN IMMEDIATE` transaction. Any invariant failure → `ROLLBACK` → `MERGE_VERIFY_FAILED`.
3. **Pre-apply refusal.** Closed days/years are checked **before** any write, not after. A merged date that already has a `day_closes` row is refused outright.
4. **Rebuild, don't increment.** The cashbox series is rebuilt wholesale from `ledger_entries` + `manual_movements` using `rebuildCashboxSeries` semantics. Incremental replay is rejected because `closing_balance` is cumulative.
5. **No ledger double-post.** The ledger has no natural key other than `client_operation_id`. Every merged ledger row carries a deterministic `client_operation_id` so re-running a merge is idempotent.
6. **No rollback of cancelled.** Cancellation is monotonic: a cancelled document always wins over an active one.
7. **No `paid` replay.** `invoices.paid` is app-owned and drifts by construction; it is never written by the merge. I-3 becomes a diagnostic.
8. **Hub idempotency.** Merged rows carry deterministic `client_operation_id` values so the hub's replay is idempotent.

---

## 2. Component Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  MERGE ENGINE (backend, SQLite desktop engine only)                   │
├─────────────────────────────────────────────────────────────────────────┤
│  mergeStage.ts        Isolated temp SQLite copy of backup ZIP         │
│  mergePlanner.ts      Read-only comparison + classification           │
│  mergeApply.ts        Single-transaction apply with invariants        │
│  replay.ts            Cashbox rebuild + roll replay (read-only math)  │
│  driveDownload.ts     Streamed download from Drive (Task 2.14, done)  │
├─────────────────────────────────────────────────────────────────────────┤
│  motard_drive_runs      Run tracking (0007 migration, done)           │
│  motard_drive_uploads   Upload ledger (0005, 0008 migrations)         │
│  motard_drive_renders   Render requests (0009 migration, done)        │
│  motard_merge_runs      NEW — audit trail of merge operations         │
│  motard_merge_plans     NEW — persisted plans for apply verification  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.1 New Tables

| Table                | Purpose                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- |
| `motard_merge_runs`  | One row per merge apply: planId, backupId, counts, invariant results, actor, timestamp  |
| `motard_merge_plans` | Persisted copy of the plan shown to the user; apply step verifies the plan hasn't stale |

### 2.2 Data Flow

```
User selects backup → Drive download (driveDownload.ts, done)
    │
    ▼
mergeStage.ts ── isolated temp SQLite copy of backup database.sqlite
    │
    ▼
mergePlanner.ts ── compare live vs staged by PK + document key
    │         → MergePlan (insert/update/keep/conflict/number-collision per table)
    │         → persisted to motard_merge_plans with expiry
    │
    ▼  User reviews plan, sets conflict choices
    ▼
mergeApply.ts ── BEGIN IMMEDIATE transaction
    │   1. Verify planId not stale (live digest comparison)
    │   2. Safety backup (createAndVerifyBackup kind=pre-operation)
    │   3. Insert missing rows with original IDs (dedup via client_operation_id)
    │   4. Apply conflict policy (cancelled wins, D-7 renumbering)
    │   5. Replay: rebuild cashbox series, roll stock from movements
    │   6. Verify invariants I-1…I-15 → COMMIT or ROLLBACK
    │   7. Write motard_merge_runs audit row
    ▼
Client invalidates financial views
```

---

## 3. Table-by-Table Merge Rules

### 3.1 Parties — insert-only by UUID

Parties are identified by UUID (primary key). A party that exists in both live and backup is kept-live (live wins — party data like name/address changes are not merged). A party only in backup is inserted with its original UUID.

**No balance write.** Party balances are derived at read time from `ledger_entries`; there is no `parties.balance` column to update.

### 3.2 Rolls — insert-only by UUID + stock movement replay

Rolls are identified by UUID. `rolls.remaining_kg` and `rolls.remaining_pieces` are **not** set directly (the domain refuses direct writes — `SqliteRollRepository.ts:156-160`). Instead:

1. Insert any rolls only in backup (original UUID).
2. For rolls in both live and backup, keep live (roll stock changes are not merged directly).
3. After all inserts, replay `stock_movements` for rolls that have new movements:
   - Insert `stock_movements` rows that exist in backup but not live (deduped by `client_operation_id`).
   - Recompute `rolls.remaining_kg` = `initial_kg` + Σ(in) − Σ(out) from `stock_movements.balance_after_kg`.
   - Recompute `rolls.remaining_pieces` = `initial_pieces` + Σ(pieces_delta) from `stock_movements.pieces_delta`.

**`remaining_pieces` reconstruction:** `stock_movements.pieces_delta` is a new column (Task 4.5). Historical rows have `pieces_delta = 0`, so reconstruction is exact only for periods where movements carry pieces data. The planner flags any roll whose pieces would change as a potential conflict.

### 3.3 Invoices — insert-only by UUID + number collision handling

Invoices have `UNIQUE(tenant_id, type, number)`. A backup invoice whose number collides with a live invoice **cannot** be inserted under its original number.

**D-7 renumbering:** The planner detects `(tenant_id, type, number)` collisions. For each collision:

1. Propose a new number (e.g., `INV-0042-R1`) that does not collide with any live row.
2. Rewrite `number` **and** `reference_number` in the **staged copy** (never in the live DB).
3. Record the mapping in the merge report for human review.

The invoice header and its lines are updated together in the staged copy. Ledger rows for the invoice are **never updated** (append-only); if the backup's invoice has different totals, the header contradicts its ledger legs — this is caught by I-10.

### 3.4 Invoice Lines — insert-only by invoice_id

Invoice lines reference `invoice_id`. They are inserted only when their parent invoice is inserted. No line-level dedup key exists beyond `(invoice_id, ...)` combinations.

### 3.5 Ledger Entries — insert-only by client_operation_id

`ledger_entries` has `client_operation_id` with partial unique index. Every merged ledger row carries a deterministic `client_operation_id` so re-running a merge is idempotent.

**Critical:** Ledger rows are **never updated**. The append-only trigger enforces this. If a historical ledger leg differs between live and backup, the merge cannot "correct" it — the existing live row stands. This is detected as a potential invariant violation (I-10) but not silently fixed.

### 3.6 Vouchers — insert-only by UUID + number collision

Same pattern as invoices: `UNIQUE(tenant_id, kind, number)`, D-7 renumbering, lines inserted with parent.

### 3.7 Returns — insert-only by UUID + number collision

Same pattern as invoices: `UNIQUE(tenant_id, kind, number)`, D-7 renumbering.

### 3.8 Stock Movements — insert-only by client_operation_id

`stock_movements` needs `client_operation_id` and `pieces_delta` columns (Task 4.5 — **not yet done**: they
do not exist in either engine; adding them needs a PostgreSQL migration and a SQLite migration together).
Movements are inserted only for rolls/lines that are being inserted. No movement is updated.

### 3.9 Cashbox Daily Balances — full rebuild

**Never incrementally updated.** After all ledger rows for a period are inserted, `rebuildCashboxSeries` is called for affected currencies:

1. `DELETE FROM cashbox_daily_balances WHERE tenant_id = ? AND currency IN (...)`
2. `INSERT ... SELECT ... sum(daily_delta) OVER (PARTITION BY currency ORDER BY day)`

The `cashbox_daily_ledger_ai` trigger is neutralized for the merge transaction via the `motard_tx_state.allow_series_rebuild` flag (mirroring `allow_dye_purge` / `allow_party_remap`).

### 3.10 Day Closes — never modified

A `day_closes` row for any merged date is a pre-apply refusal. The merge does not touch `day_closes` or `financial_years`.

---

## 4. Invariant Set (I-1 through I-15)

All invariants are evaluated **before COMMIT**. Any failure → `ROLLBACK` → `MERGE_VERIFY_FAILED`.

| #    | Invariant                                                                  | Scope                             | Gate?           |
| ---- | -------------------------------------------------------------------------- | --------------------------------- | --------------- |
| I-1  | Per party/currency, `SUM(active ledger legs)` = statement-reported balance | All merged periods                | Yes             |
| I-2  | Per invoice: `header.total` = `SUM(lines)` after discounts                 | Imported invoices                 | Yes             |
| I-3  | `invoices.paid` − Σ applied vouchers ≤ tolerance                           | Imported invoices                 | Diagnostic only |
| I-4  | `0 ≤ remaining_kg ≤ initial_kg`                                            | Touched rolls                     | Yes             |
| I-5  | `PRAGMA foreign_key_check` empty                                           | Whole DB                          | Yes             |
| I-6  | No cancelled document became active                                        | Imported docs                     | Yes             |
| I-7  | No duplicate ids; no duplicate `(tenant, type, number)` except D-7 flagged | All inserted rows                 | Yes             |
| I-8  | Cashbox series = rebuild from ledger + manual                              | Imported period + all dates after | Yes             |
| I-9  | `integrity_check = ok`                                                     | Whole DB                          | Yes             |
| I-10 | Per invoice per currency: `Σ(active legs)` = `header.total` ± 2dp          | Imported invoices                 | Yes             |
| I-11 | Per invoice: `Σ(stock_movements)` = `Σ(invoice_lines)` kg + pieces         | Imported invoices                 | Yes             |
| I-12 | `invoices.paid` diagnostic (not a gate)                                    | Imported invoices                 | No (diagnostic) |
| I-13 | No imported row intersects `day_closes` or `closed financial_years`        | All imported dates                | Yes (pre-apply) |
| I-14 | Rebuilt cashbox = pre-merge series for all dates **after** merge window    | All dates after merge             | Yes             |
| I-15 | Per roll: `0 ≤ remaining_kg ≤ initial_kg` and `remaining_pieces ≥ 0`       | Touched rolls                     | Yes             |

**Critical gap filled by I-10:** The previous plan had no check that an invoice header agrees with its own ledger legs. I-10 is evaluated **per invoice, per currency** — aggregate sums hide per-document errors.

---

## 5. Apply Procedure (Single Transaction)

```
BEGIN IMMEDIATE;

1. Verify planId exists, not expired, and live digest matches plan-time digest
   → PLAN_STALE if different

2. Safety backup: createAndVerifyBackup({kind: "pre-operation"})

3. For each table in FK order (parties → rolls → invoices → invoice_lines →
   returns → return_lines → vouchers → ledger_entries → stock_movements →
   cashbox tables → day_closes / manual_movements):

   a. Insert missing rows with original UUIDs (deduped by client_operation_id)
   b. Apply conflict policy (cancelled wins, D-7 renumbering)
   c. Apply user's conflict choices (default: keep live)

4. Run replay:
   a. Rebuild cashbox series for affected currencies (rebuildCashboxSeries)
   b. Recompute roll stock from stock_movements
   c. Neutralize cashbox_daily_ledger_ai trigger for this transaction

5. Check invariants I-1…I-15 → any failure → ROLLBACK → MERGE_VERIFY_FAILED

6. Write motard_merge_runs audit row

COMMIT;
```

### 5.1 Pre-Apply Refusal (I-13)

Before any write, the planner checks:

- Any imported invoice date falls within a `day_closes` row → refuse
- Any imported invoice date falls within a `closed` `financial_years` year → refuse
- This is enforced in the planner **and** re-checked inside the transaction

### 5.2 Stale Plan Detection

The planner records a live digest (hash of affected table row counts + max `updated_at`) at plan time. The applier re-computes the digest before writing; if different → `PLAN_STALE`.

---

## 6. Hub Interaction (G-11)

After a merge completes:

1. Merged rows carry deterministic `client_operation_id` values so the hub's replay is idempotent.
2. After merge, `takeHubFingerprint` equality must be re-established for the affected tenant — the fingerprint covers `SUM(debit)−SUM(credit)` per party/currency and `rolls.remaining_kg`/`remaining_pieces`.
3. If the hub has newer data for a merged document, the hub's version wins (hub is the source of truth for cross-device sync).

---

## 7. What Is NOT in Scope

| Item                                     | Reason                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Party balance replay                     | Balances derived at read; `party_balances` table dropped                   |
| Naive cashbox replay (incremental delta) | Would double-count against trigger-maintained series                       |
| Ledger insert without identity           | `client_operation_id` provides dedup                                       |
| Pieces replay without `pieces_delta`     | `stock_movements.pieces_delta` is the audit trail                          |
| D-7 flag-only policy                     | `UNIQUE(tenant_id, type, number)` rejects colliding inserts; must renumber |
| I-3 as hard gate                         | `invoices.paid` drifts by construction; diagnostic only                    |

---

## 8. Files Affected

| File                                                                                                                                                                                            | Change                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/MERGE_ENGINE_DESIGN.md`                                                                                                                                                                   | **New** — this document                                                                                                                                                                                                                        |
| `docs/GOOGLE_DRIVE_AND_SMART_BACKUP_PLAN.md`                                                                                                                                                    | §5 rewritten to reflect this design                                                                                                                                                                                                            |
| `backend/src/infrastructure/orm/migrations/<next>_stock_movement_identity.sql` (PG) **and** `orm/sqlite/migrations/<next>_stock_movement_identity.sql` (SQLite, with its `_journal.json` entry) | **To write** — `stock_movements.client_operation_id` + `pieces_delta`, then the PG schema, the generated SQLite schema and both fingerprints (`npm run typecheck:sqlite`). `ledger_entries.client_operation_id` already exists — no migration. |
| `orm/sqlite/migrations/<next>_merge_runs.sql` (+ journal)                                                                                                                                       | **To write** — the `motard_merge_runs` / `motard_merge_plans` audit tables. Migrations live in `orm/sqlite/migrations/`, never in a source folder.                                                                                             |
| `backend/src/infrastructure/backup/merge/{mergeStage,mergePlanner,mergeApply,replay}.ts`                                                                                                        | **To write.** (A first prototype was removed on 2026-10-21 as unsafe — stubbed invariants, float money, broken cashbox SQL; see `docs/REMEDIATION_AND_CORRECTION_PLAN.md` §8.3.)                                                               |

---

_End of design document._
