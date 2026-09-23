# MOTARD ERP — Verified Repair Plan (v2)

> **Status of this document:** APPROVED AS DRAFT — NOT YET A FINAL RELEASE PLAN.
> It becomes a release plan only when every item in §19 (human decisions) is answered and every
> Phase-0 release gate in §15/§16 is green.
>
> Produced under `SKILL.md` (motard-deep-audit): read-only investigation; this file is the only artifact.
> Inputs: `divin-plean.md` (original audit), `impove-the-PEPAIR-PLAN.md` (review of plan v1, 810 lines),
> and the actual repository (branch `clean-desktop-release`, HEAD `6383f7f5` **plus a large uncommitted
> working tree**, including the 2026-09-23 sync-settings / customer-credit / soft-light-theme changes).
> Line numbers refer to the working tree as inspected on 2026-09-23.

## Contents

0. Executive Summary
1. Scope and Rules
2. Investigation Method (and what changed from v1)
3. Findings Rejected or Not Proven (report **and** review)
4. Confirmed Findings — master table
5. Data Safety Model (state machine) and Repair Dependency Map
6. Detailed Repair Items — by phase
   - Phase 0 — Protect customer data before anything else (REPAIR-013, 014, 023, 024, 025/015, 026, 028)
   - Phase 1 — Correctness (REPAIR-004a, 008, 009, 010, 011, 021)
   - Phase 2 — Concurrency and sync (REPAIR-007, 027, 012/019)
   - Phase 3 — Data completeness and performance (REPAIR-002, 001, 003, 005, 004b, 006, 016, 020)
   - Phase 4 — Long-term operations (REPAIR-017, 029, 018, 022)
   - Cross-cutting release blockers (REPAIR-030, 031)
7. Database / Query Repairs (index & migration register)
8. Frontend Performance Repairs
9. Backend / API Repairs
10. Synchronization Repairs
11. Desktop / Runtime Repairs
12. Security / Reliability Repairs
13. Dead Code / Duplication Cleanup
14. Required Tests (complete list)
15. Verification Matrix
16. Implementation Order and Release Gates
17. Protected Business Rules
18. Files Explicitly Out of Scope
19. Open Questions Requiring Human Decision
20. Final Repair Summary and Honest Readiness Assessment

---

## 0. Executive Summary

**What is broken today (verified):**

1. **Customer data can disappear without the application noticing.** On 2026-09-23 09:58 the desktop
   app on this machine started with a brand-new database while older identity files survived. The
   application never recorded *why* (boot decisions go to a discarded stderr; `server.log` is truncated on every
   boot). There is no persistent record of "how much data this installation had", no pre-operation snapshot,
   and no automatic backup. **This is the highest-risk area and is Phase 0.**
2. **Restore can destroy data.** `backend/scripts/restore-from-backup.mjs` deletes every row of the tenant, then
   re-inserts `database.json`. A backup whose `warnings` array is non-empty (a table dump failed and was written
   as `[]`) is restored without complaint, so the failed table is wiped. The backup endpoint also returns
   HTTP 200 for such a backup.
3. **Reports and pickers silently use only the newest 1,000 rows** (21 call sites). The customer/supplier
   balances report is wrong after only a few hundred invoices.
4. **The dashboard blends currencies** in its no-cash-session branch.
5. **Sync claiming is not atomic, and stale workers can overwrite newer outcomes.** There is no lease owner or
   token, `markSynced` updates by `id` only, and there is no server-side run lock.
6. **Concurrency:** rolls are locked in input order, so opposite-order sales can deadlock.
7. **Legacy desktop clusters can be stamped as fully migrated without running migrations**, relying on a
   gap-closer that no longer exists.
8. **Performance root causes:** no index on `returns.original_invoice_id` or on `manual_movements`; 33
   sequential dashboard queries; unescaped `%term%` search.

**What this plan does not claim:** it does not claim the system is "100/100", "lives ten years", or
"withstands any load". No load was ever measured. §20 states precisely what becomes proven after each phase.

**Order of work:** Phase 0 (data safety) → Phase 1 (correctness) → Phase 2 (concurrency/sync) →
Phase 3 (completeness/performance) → Phase 4 (long-term operations). REPAIR-030 (upgrade-over-real-data test
matrix) and REPAIR-031 (performance gates) are **release blockers** for every installer shipped after Phase 0.

---

## 1. Scope and Rules

- Every claim in `divin-plean.md` **and** in `impove-the-PEPAIR-PLAN.md` was treated as a claim, then verified,
  corrected, or rejected. The review file is guidance, not truth: one of its factual statements is wrong
  (§3, row R-1).
- Nothing in the project was modified. The disposable dev PostgreSQL (`.tmp-pgdata-dev`, DB `erp_test`, built by
  this repo's migration chain) was started only to read `pg_indexes`/`pg_extension` with
  `default_transaction_read_only = on`, then stopped. The user's `%LOCALAPPDATA%\motard-erp` was listed and
  grepped only.
- **No runtime performance was measured.** Every complexity statement is STATIC. Every threshold in this
  document is marked either *existing* (found in the repo) or **PROPOSED — requires agreement (§19)**.
- Business rules are protected (§17). Anything needing a business decision is marked
  **BUSINESS RULE UNCERTAIN — HUMAN DECISION REQUIRED** and listed in §19.
- Every repair item states FILES TO CHANGE / FILES READ-ONLY / FILES NOT TO CHANGE, plus the invariants and
  contracts it must preserve, so the implementing agent cannot widen scope.

### Conventions used in repair items

- **New migration files** follow the existing hand-written style: `backend/src/infrastructure/orm/migrations/<YYYYMMDD>_<name>.sql`,
  appended to `meta/_journal.json` with `idx` = last + 1 (currently last = 78, `20261001_customer_credit_application`),
  `version: 7`, `breakpoints: true`, `when` strictly increasing. Every new index/column must also be declared in
  the drizzle schema file so that `tests/schema-migration-parity.test.ts` and the future REPAIR-025 manifest agree.
- **Tests:** backend tests live in `backend/tests/*.test.ts` (vitest, live Postgres through
  `node backend/scripts/ensure-test-db.mjs`; use `databaseReachable()` from `tests/_helpers/requireDatabase.ts`,
  which throws instead of silently skipping when `DATABASE_URL` is set). Frontend tests live next to the source
  (`src/**/*.test.ts`, node environment, no testing-library). Rust tests use `#[cfg(test)]` modules in
  `desktop/src-tauri/src/**` (run with `cargo test`).
- **Standard verification commands** (referred to as `VERIFY-ALL`):
  ```
  node backend/scripts/ensure-test-db.mjs          # dev PostgreSQL on :5432 must be running
  cd backend && npx tsc --noEmit -p . && npx vitest run
  cd .. && npx tsc --noEmit -p . && npx vitest run
  cd desktop/src-tauri && cargo test
  ```

---

## 2. Investigation Method (and what changed from v1)

1. Oriented on the real runtime paths: React SPA (`src/`), shared Zod contracts (`packages/shared/src`),
   Express API (`backend/src/presentation`), use cases, Postgres repositories, drizzle schemas + SQL migration
   journal, sync (outbox / hub inbox / pull cursor), and the Tauri runtime (`desktop/src-tauri/src/runtime`,
   `db_meta.rs`).
2. For each claim: opened the cited file, read the whole function, traced callers and callees with ripgrep, then
   searched the repository for the same pattern.
3. Verified database facts against the real catalog of a migration-built database, not against drizzle
   declarations (they disagree; see REPAIR-020).
4. Verified the desktop incident facts on the user's machine, read-only.

**Additional verification done for v2 (driven by the review):**

| Review point | What was checked | Result |
|---|---|---|
| "An index exists on `returns.original_invoice_id` (`return.table.ts:44-50`)" | `return.table.ts:44-50`; `0001_initial.sql:542`; `pg_indexes` | **Wrong.** Lines 44-50 declare only `UNIQUE (tenant_id, kind, number)`. Line 542 is `REFERENCES invoices(id)`, and PostgreSQL does not index FK columns automatically. The catalog has no such index. REPAIR-003 stands. |
| `Promise.all` could trigger "client.query() while already executing" | `backend/src/infrastructure/orm/drizzle.ts` (`TenantScopedPool`) | `db = drizzle(pool)`. Outside a transaction **each query checks out its own pooled client**, and `connect()` stamps the tenant GUC from AsyncLocalStorage in **one** statement (the old two-statement `Promise.all` in `stamp()` was the source of the warning; already fixed). Inside `db.transaction(tx => …)` all queries share **one** client, so `Promise.all` there **is** unsafe. The pool has `max: 20` (`drizzle.ts:86`), so wide top-level `Promise.all` also consumes connections. REPAIR-004b is refined accordingly. |
| Backup "succeeds" with warnings | `backend/src/presentation/routes/backup.route.ts:207-243`, lines 80-97 | Confirmed: failed table dumps become `[]` plus an entry in `warnings`; the endpoint streams the ZIP with HTTP 200 regardless. |
| Restore safety | `backend/scripts/restore-from-backup.mjs` (512 lines) | Confirmed and **worse than the review said**: it never reads `warnings`, deletes all tenant rows (`DELETE ... WHERE tenant_id = $1`, line 262), then inserts the dump. A table that failed to dump is therefore **wiped on restore**. |
| Automatic backups | `rg setInterval/cron/schedule` in the backend | None. Backup is manual only (`POST /api/backup/full`). |
| Idempotency is only a 5-minute retry guard | `backend/src/infrastructure/http/middleware/idempotency.middleware.ts:40-46` | Confirmed: `IDEMPOTENCY_TTL_SECONDS = 300`, documented as "an HTTP retry guard only". Durable dedupe exists **only** for sync (`(tenant_id, op_id)`). |
| Lease columns for sync | `backend/src/infrastructure/orm/schemas/sync-outbox.table.ts:23-53`; `PostgresSyncOutboxRepository.ts:18,74-127` | No `lease_owner/token/until`. The lease is `updated_at + 5 min` (`DEFAULT_PUSHING_LEASE_MS`). `markSynced`/`markRejected`/`resetToPending` filter by `id` only, so a stale worker can overwrite a newer outcome. |
| Can the desktop take a `pg_dump` snapshot today? | `desktop/src-tauri/resources/postgres/bin`, `desktop/scripts/resource-manifest.json` | **No.** Only `createdb, initdb, pg_ctl, postgres, psql` are bundled; `pg_dump.exe` / `pg_restore.exe` must be added (REPAIR-024 step 0). |
| JWT signature failures on the device | `%LOCALAPPDATA%\motard-erp\logs\erp.1.log` | 6 occurrences of `JWSSignatureVerificationFailed` (consistent with a rotated/new `JWT_SECRET` after a cluster change). |

Tools: ripgrep, sed/awk, TypeScript source reading, `node` + `pg` (read-only catalog query), PowerShell listing.
ast-grep, semgrep, madge, and jscpd were **not** run; occurrence searches are regex-based and marked PARTIAL where
exhaustiveness matters.

---

## 3. Findings Rejected or Not Proven

### 3.1 From `divin-plean.md`

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| D-1 | Party DELETE drops `expectedVersion` body | **NOT CONFIRMED** (already fixed) | `src/infrastructure/http/BaseHttpClient.ts:152-157` sends a JSON body for every non-GET method; `PartyApiService.ts:47` passes `{ body: { expectedVersion } }`. |
| D-2 | Profit DTO ≠ backend response | **NOT CONFIRMED** | `src/contracts/profit.ts:13-78` is identical to `backend/src/domain/entities/Profit.ts:23-100`. |
| D-3 | Cash-movement currency not sent | **NOT CONFIRMED** | Only caller `src/routes/cashbox.tsx:371-377` sends `currency`; the type requires it; the schema keeps it (`cashbox.schema.ts:15`). |
| D-4 | Negative cashbox = DEFECT | **NOT CONFIRMED as defect** (intended rule) | `cashboxBalanceHelper.ts:116-121`, `PostgresVoucherRepository.ts:154-155`, and the UI warning in `VoucherForm.tsx`. Only the misleading naming remains (REPAIR-021). |
| D-5 | `profitCalc.ts` duplicates server COGS | **NOT CONFIRMED** | No such file under `src/`. |
| D-6 | Desktop spawns Node `:8080` + SSR `:4173` | **NOT CONFIRMED** (pre-v2 architecture) | `desktop/src-tauri/src/runtime/ports.rs:9-24` (persisted random high port, one server). |
| D-7 | `party_balances` is live dead infrastructure | **NOT CONFIRMED** (outdated) | Dropped by `0038_drop_party_balances.sql:10`. |
| D-8 | Template is copied over the customer database | **NOT CONFIRMED** in that form | `db_meta.rs:128-200` never overwrites an existing `pgdata`; mismatches fail closed. The real, narrower gaps are REPAIR-014/023. |
| D-9 | Desktop reads a different tenant | **NOT PROVEN** | Desktop auth forces `slug='default'` server-side. Multiple tenant sources exist, so REPAIR-026 adds a detector rather than assuming a bug. |
| D-10 | Data permanently deleted | **NOT PROVEN** | See REPAIR-013 evidence. |
| D-11 | Crash at 10K invoices | **NOT PROVEN** | No mechanism found. |
| D-12 | Any timing / threshold | **NOT MEASURED** | No load data exists. |
| D-13 | `ApiError.statusCode`, invoice type `"return"` | **Type-level only** | Runtime unaffected; folded into REPAIR-011. |

### 3.2 From `impove-the-PEPAIR-PLAN.md`

| # | Claim | Verdict | Evidence / consequence |
|---|---|---|---|
| R-1 | "Index exists on `returns.original_invoice_id` (`return.table.ts:44-50`)" | **WRONG** | See §2. REPAIR-003 is kept. |
| R-2 | "`Promise.all` in the dashboard may reproduce `client.query() while executing`" | **PARTIALLY CORRECT** | Safe at the top level (separate pooled clients); unsafe inside a transaction; pool pressure is real. REPAIR-004b sets explicit rules. |
| R-3 | "Idempotency must be mandatory server-side with a durable business operation id" | **Accepted with a scope decision** | REPAIR-008 now has two parts; part B (durable ids) needs §19 Q13 because it changes the API contract for non-first-party callers. |
| R-4 | "Lease owner/token/until needed" | **CONFIRMED** | New REPAIR-027. |
| R-5 | "Backup API must not report success with warnings" | **CONFIRMED** and extended to restore | REPAIR-028. |
| R-6 | "Sentinel columns are not enough for baseline" | **Accepted** | REPAIR-015 is replaced by REPAIR-025 (full schema fingerprint); REPAIR-015 remains as the interim fail-closed step. |
| R-7 | "20 × 1,000 page loops are not a long-term fix" | **Accepted** | REPAIR-001 now uses server-side typeahead for pickers; page loops are allowed only for bounded, non-picker uses. |
| R-8 | "Performance gates must be real, not 'suggested'" | **Accepted as a process requirement** | REPAIR-031 defines the gate *structure*. Numeric limits cannot be invented; they are PROPOSED defaults that must be agreed (§19 Q14). |

---

## 4. Confirmed Findings — master table

| ID | Phase | Finding | Status | Severity |
|---|---|---|---|---|
| REPAIR-013 | 0 | Boot decisions not persisted; `server.log` truncated each boot | CONFIRMED | CRITICAL (forensics) |
| REPAIR-014 | 0 | Missing `pgdata` with existing `db-meta.json` silently provisions an empty DB | CONFIRMED | CRITICAL |
| REPAIR-023 | 0 | No persistent data-integrity manifest / startup data-safety gate | CONFIRMED (absence) | CRITICAL |
| REPAIR-024 | 0 | No pre-operation snapshot before migration / upgrade / factory reset / restore | CONFIRMED (absence) | CRITICAL |
| REPAIR-015 | 0 | Blind full-journal baseline on legacy clusters (interim fail-closed step) | CONFIRMED | HIGH |
| REPAIR-025 | 0 | No full schema fingerprint; parity test covers columns only | CONFIRMED | HIGH |
| REPAIR-026 | 0 | No tenant / data-visibility consistency check at login | CONFIRMED (absence); defect NOT PROVEN | HIGH |
| REPAIR-028 | 0 | Backup reports success with `warnings`; restore wipes and ignores `warnings`; no automatic backup; no restore drill | CONFIRMED | CRITICAL |
| REPAIR-004a | 1 | Dashboard no-session cash branch blends currencies | CONFIRMED | HIGH |
| REPAIR-008 | 1 | Idempotency missing on 3 financial routes; only a 5-minute HTTP guard elsewhere | CONFIRMED | HIGH |
| REPAIR-009 | 1 | Money inputs not 2-dp validated; stored components can drift from total by 0.01 | PARTIALLY CONFIRMED | MEDIUM |
| REPAIR-010 | 1 | Party status "موقوف" silently stripped | CONFIRMED | MEDIUM |
| REPAIR-011 | 1 | Frontend `LedgerType` incomplete | CONFIRMED | LOW |
| REPAIR-021 | 1 | Misleading cashbox names and comments | CONFIRMED | LOW |
| REPAIR-007 | 2 | Non-atomic outbox claim; no run lock | CONFIRMED | HIGH |
| REPAIR-027 | 2 | No lease owner/token; stale workers can overwrite outcomes | CONFIRMED | HIGH |
| REPAIR-012/019 | 2 | Unordered roll locks (deadlock); per-roll round-trips | CONFIRMED (mechanism) | MEDIUM |
| REPAIR-002 | 3 | Party balances report computed on a 1,000-row ledger slice | CONFIRMED | HIGH |
| REPAIR-001 | 3 | 21 silent 1,000-row call sites | CONFIRMED | HIGH |
| REPAIR-003 | 3 | No index on `returns.original_invoice_id` (root cause of correlated-subquery cost) | CONFIRMED | HIGH |
| REPAIR-005 | 3 | `manual_movements` unindexed and loaded whole | CONFIRMED | MEDIUM |
| REPAIR-004b | 3 | 33 sequential dashboard queries; all-time top fabrics; own cash formula | CONFIRMED | MEDIUM |
| REPAIR-006 | 3 | `%term%` search unescaped; no trigram; unsupported list order | CONFIRMED (static) | MEDIUM |
| REPAIR-016 | 3 | 32 query functions ignore AbortSignal | CONFIRMED | LOW-MEDIUM |
| REPAIR-020 | 3 | Drizzle declares an index no migration creates | CONFIRMED | LOW |
| REPAIR-017 | 4 | No device outbox retention | CONFIRMED | LOW (grows) |
| REPAIR-029 | 4 | No hub snapshot / bootstrap / compaction architecture | CONFIRMED (absence) | HIGH over years |
| REPAIR-018 | 4 | Unused archive tables | PARTIALLY CONFIRMED | LOW |
| REPAIR-022 | 4 | `idempotency_keys` never swept | CONFIRMED | LOW |
| REPAIR-030 | gate | No upgrade-over-real-data test matrix | CONFIRMED (absence) | CRITICAL (release blocker) |
| REPAIR-031 | gate | No formal performance / resource gates | CONFIRMED (absence) | HIGH (release blocker for "scale" claims) |

---

## 5. Data Safety Model and Repair Dependency Map

### 5.1 Desktop data-safety state machine (target design)

Every desktop boot must end in exactly one **recorded** decision. Today only the first three exist, and none of
them is recorded durably.

```
                       ┌───────────────────────────────────────────────┐
 boot ──► read manifest (REPAIR-023) + db-meta + pgdata presence       │
          │                                                            │
          ├─ first install (no manifest, no meta, no pgdata) ─► FRESH_TEMPLATE ──► write manifest
          ├─ factory reset confirmed (flag + manifest.resetAuthorized) ─► SNAPSHOT (024) ─► FACTORY_RESET ─► FRESH_TEMPLATE
          ├─ intentional restore (restore marker from REPAIR-028) ─► RESTORE_VERIFY ─► REUSE
          ├─ pgdata present + meta ok + schema fingerprint ok (025)
          │        └─► DATA CHECK (023): counts vs last-known
          │               ├─ within tolerance ─► REUSE ─► TENANT CHECK (026) ─► open app
          │               └─ severe drop     ─► SAFE_MODE (read-only diagnostics; no writes; no new DB)
          ├─ pgdata missing + (meta OR manifest present) ─► REFUSE: DATA_MISSING (014/023) ─► recovery screen
          ├─ schema fingerprint mismatch / no drizzle history ─► SNAPSHOT (024) ─► REFUSE: SCHEMA_UNVERIFIED (015/025)
          └─ migration failed ─► REFUSE: MIGRATION_FAILED (snapshot kept; `[FATAL]` reason shown)
```

Recorded events (REPAIR-013 vocabulary): `REUSE`, `FRESH_TEMPLATE`, `FRESH_INITDB`, `FACTORY_RESET`,
`RESTORE_VERIFY`, `SAFE_MODE`, `DATA_MISSING`, `SCHEMA_UNVERIFIED`, `MIGRATION_STARTED`, `MIGRATION_OK`,
`MIGRATION_FAILED`, `SNAPSHOT_CREATED`, `SNAPSHOT_FAILED`, `TENANT_SELECTED`, `TENANT_MISMATCH`.

Coverage of the eight situations raised by the review:

| Situation | Detected by | Outcome |
|---|---|---|
| New database where one existed | 014 + 023 (manifest survives outside pgdata) | REFUSE `DATA_MISSING` |
| Old database, different tenant | 026 | `TENANT_MISMATCH` → block writes, show diagnostics |
| Database missing migrations | 025 (+ 015 interim) | REFUSE `SCHEMA_UNVERIFIED` |
| Database emptied (tables present, rows gone) | 023 count check | `SAFE_MODE` |
| Incomplete restore | 028 (restore refuses warnings; post-restore count verification) + 023 | REFUSE / `SAFE_MODE` |
| Wrong sync cursor | 028 (restore rules) + existing clamp in `restore-from-backup.mjs` + 029 | verified at restore; hub-side covered by 029 |
| Data exists but login cannot see it | 026 | `TENANT_MISMATCH` |
| Failed migration | 024 snapshot + 013 event | REFUSE `MIGRATION_FAILED`, snapshot available |
| `db-meta` **and** `pgdata` both deleted | 023 manifest lives in a separate file (and a copy under `logs/`) | REFUSE `DATA_MISSING` |

### 5.2 Dependency map

```
PHASE 0
 013 boot log ──► every other desktop item logs through it
 023 manifest ──► 014 fail-closed (uses manifest + meta) ──► 026 tenant check (uses manifest.tenantId)
 024 snapshot ──► required by 015/025 refusal paths, factory reset, restore, migrations
 015 interim fail-closed baseline ──► replaced by 025 full fingerprint
 028 backup/restore correctness ──► 023 (lastSuccessfulBackupAt), 024 (shares the snapshot format)

PHASE 1 (independent small fixes)       PHASE 2
 004a, 008, 009, 010, 011, 021           007 atomic claim ──► 027 lease token (same code) ; 012/019 lock order

PHASE 3
 003 returns index ──► 004b dashboard, profit debts, customerCredit
 005 manual_movements index ──► 004b cash via shared helper
 002 party balances ──► part of 001
 001 typeahead + server reports ── largest frontend change
 006 search (measure first, needs 031 harness)

PHASE 4
 017 device outbox retention ; 029 hub snapshot/bootstrap (prerequisite for any hub compaction)
 018 archive decision ; 022 idempotency sweep

GATES: 030 upgrade matrix (blocks every installer after Phase 0) ; 031 perf gates (blocks "scale" claims, measures 001/003/004/006)
```

---

## 6. Detailed Repair Items

---

# PHASE 0 — Protect customer data before anything else

Phase 0 changes only the desktop boot path, the backup/restore path, and add-only checks. It does not touch
business logic. It must ship before any other installer is handed to a user.

---

## REPAIR-013 — Durable, structured boot-decision log

Status: CONFIRMED

Category: Desktop reliability / forensics

Severity: CRITICAL (it made the 2026-09-23 incident undiagnosable)

Evidence:
- `desktop/src-tauri/src/runtime/mod.rs:31-33`: `pub(crate) fn log(msg) { eprintln!(...) }`, stderr only.
- `desktop/src-tauri/src/main.rs:1`: `windows_subsystem = "windows"` in release, so stderr is discarded.
- `desktop/src-tauri/src/runtime/stack.rs:968-969`: `fs::File::create(server.log)` truncates the backend log on every boot.
- User machine (read-only): `server.log` = 0 bytes; the lines "copying baked pgdata-template", "pgdata already
  provisioned", and "factory-reset requested" exist in code but appear in no file.

Source Findings: divin-plean desktop section; review §"REPAIR-013 excellent, but logging needs protection".

Exact Functions: `runtime::log`, `stack.rs::spawn_backend` (server-log open), `ensure_pgdata`,
`apply_requested_factory_reset`, `db_meta::evaluate_existing_cluster`.

Current Behavior: decisions are invisible after the fact.

Expected Behavior: every boot leaves one durable, structured record of what the runtime decided and why.

Root Cause: logging was designed for a console, but the product ships as a windowless GUI process.

Technical Repair:
1. New module `desktop/src-tauri/src/runtime/boot_log.rs`:
   - Appends JSON lines to `%LOCALAPPDATA%\motard-erp\logs\boot.log`:
     `{ "ts": RFC3339, "bootId": uuid, "event": "<VOCABULARY>", "stage": "...", "details": {...} }`.
   - `bootId` is generated once per process and exported to the Node backend as env `MOTARD_BOOT_ID`. The
     backend logger adds it to every line; the PostgreSQL `log_line_prefix` gets it through
     `application_name=motard-<bootId>` on backend connections. This gives one correlation id across the boot
     log, the server log, and PostgreSQL.
   - **Rotation by size:** when `boot.log` exceeds 1 MiB, rename `boot.log.N` → `boot.log.N+1` for N = 4..1
     (delete `.5`), then `boot.log` → `boot.log.1`. Retention: 5 files (≈5 MiB). *(Sizes are PROPOSED defaults;
     §19 Q15.)*
   - **Atomic append:** open with `OpenOptions::new().create(true).append(true)` and write each record with one
     `write_all` of the full line (Windows append of a single buffer is atomic for our sizes; the runtime is
     single-writer).
   - **Redaction:** `details` only accepts an allow-list of keys (`pgdataExists`, `metaPresent`,
     `manifestPresent`, `schemaIdx`, `bundledSchemaIdx`, `pgMajor`, `installationIdPrefix` (first 8 chars),
     `tenantIdPrefix`, `counts`, `reason`, `path` (relative to app data)). Never log passwords, the DB password,
     JWT, `secrets.dat` content, or full ids.
   - **ACL:** the folder already lives under the per-user `%LOCALAPPDATA%` (user-only ACL by default). Do not
     create logs under ProgramData or any shared location.
   - Best-effort: any I/O error while logging is swallowed and never fails boot.
2. `runtime::log()` keeps `eprintln!` and also forwards to `boot_log::event("TRACE", ...)`.
3. `stack.rs:968`: rotate `server.log` → `server.log.1` (keep 3 generations) **before** `File::create`. The
   fatal dialog (`last_fatal_reason`, `log_tail_for_dialog`, `stack.rs:1212-1275`) keeps reading the **current**
   `server.log`, which is unchanged behaviour.
4. Emit exactly one decision event per boot from `ensure_pgdata` (`REUSE` / `FRESH_TEMPLATE` / `FRESH_INITDB`),
   from `apply_requested_factory_reset` (`FACTORY_RESET`), and from every refusal path added in 014/015/023/025.
5. The backend emits `MIGRATION_STARTED/OK/FAILED` (from `runDesktopMigrations`) and `TENANT_SELECTED` (from
   REPAIR-026) to its own log with the same `bootId`. The runtime copies the last backend `[FATAL]` line into
   `boot.log` when a boot fails.

Files To Modify: `desktop/src-tauri/src/runtime/mod.rs`, new `runtime/boot_log.rs`, `runtime/stack.rs`
(server-log rotation, event calls, `MOTARD_BOOT_ID` env), `db_meta.rs` (events only);
`backend/src/infrastructure/config/logger.ts` (add `bootId` field from env);
`backend/src/infrastructure/orm/runDesktopMigrations.ts` (events); `backend/src/infrastructure/orm/drizzle.ts`
(`application_name` in the connection config, desktop only).

Files Read-Only: `runtime/error.rs`, `runtime/stages.rs`.

Files Not To Change: `secret_store.rs`, `device_binding.rs`, `fingerprint.rs`, `identity.rs`.

Business rules / invariants to preserve: boot order and stage semantics (`stages::ALL`); fail-fast behaviour; the
fatal dialog text.

Implementation Steps: (1) boot_log module + unit tests; (2) route `log()`; (3) server.log rotation; (4) decision
events; (5) backend `bootId` field; (6) migration events.

Tests To Add:
- Rust `boot_log::tests`: append writes one line per event; rotation at the size threshold keeps exactly 5 files;
  a disallowed key is dropped; an I/O error does not panic.
- Rust `stack::tests`: server.log rotation keeps the previous generation; `last_fatal_reason` still reads the
  current file.
- Backend: logger includes `bootId` when `MOTARD_BOOT_ID` is set.

Verification: `cargo test`; manual — boot the packaged app twice → `boot.log` has two `REUSE` records with
different `bootId`s, and `server.log.1` holds the previous boot.

Success Criteria: after any boot (successful or failed), `boot.log` contains exactly one cluster-decision event
for that `bootId`.

Regression Risks: disk growth (bounded by rotation); a slow disk delaying boot (appends are small, best-effort).

Rollback: remove the module; the behaviour of boot is unchanged by it.

Open Questions: §19 Q15 (sizes and retention).

---

## REPAIR-023 — Persistent data-integrity manifest and startup data-safety gate

Status: CONFIRMED (absence) — required by the review; verified that nothing equivalent exists

Category: Data safety

Severity: CRITICAL

Evidence: the only persistent metadata outside `pgdata` is `db-meta.json` (`db_meta.rs:DbMeta` =
`installation_id, pg_major, schema_journal_idx, created_at`), and factory reset deletes it
(`stack.rs:299`). Nothing records how much data existed, so an emptied or replaced database is indistinguishable
from a legitimate one. On the user's machine both `pgdata` and `db-meta.json` were created at 09:58 on
2026-09-23; the previous state is unknowable.

Current Behavior: the app opens normally on an empty or emptied database.

Expected Behavior (new safety rule, not a business rule): a sudden severe drop in business data blocks normal
start and shows a recovery/diagnostic screen. Exceptions: first install, a confirmed factory reset, and a verified
intentional restore.

Technical Repair:
1. File `%LOCALAPPDATA%\motard-erp\data-integrity.json` (plus a mirror `logs\data-integrity.last.json` written
   after the main file, so that deleting one file is not enough to lose the reference):
   ```json
   {
     "version": 1,
     "installationId": "…",
     "tenantId": "…",
     "schemaJournalIdx": 78,
     "lastKnownCounts": { "tenants": 1, "users": 3, "parties": 250, "invoices": 4200,
                          "invoiceLines": 18000, "rolls": 900, "ledgerEntries": 28000,
                          "vouchers": 1900, "returns": 40, "syncOutboxPending": 0 },
     "lastKnownDatabaseSizeBytes": 123456789,
     "lastVerifiedAt": "RFC3339",
     "lastSuccessfulBackupAt": "RFC3339 | null",
     "lastBootDecision": "REUSE",
     "resetAuthorized": false,
     "restoreInProgress": null
   }
   ```
   Written atomically (write `*.tmp`, `fsync`, rename).
2. **Who writes it:** the Node backend, which has the DB connection. New module
   `backend/src/infrastructure/integrity/dataIntegrityManifest.ts`:
   - `collectCounts(tenantId)`: one SQL statement with `SELECT count(*)` subselects per table, run under
     `runWithPlatformContext` (read-only).
   - `pg_database_size(current_database())` for the size.
   - Called: (a) after a successful boot (after migrations and REPAIR-026), (b) every 30 minutes while running
     (`setInterval(...).unref()`), (c) after a successful backup (REPAIR-028), (d) on graceful shutdown.
   - Desktop only (`config.DESKTOP_DEPLOY`); the path comes from a new env `DATA_INTEGRITY_PATH` set by
     `stack.rs` next to `HUB_CONFIG_PATH`.
3. **Who enforces it:** two layers.
   - **Rust (before PostgreSQL starts):** `db_meta::evaluate_existing_cluster` reads the manifest. If `pgdata`
     is missing and the manifest exists with `lastKnownCounts.invoices + parties + rolls > 0` and
     `resetAuthorized == false`, return `DATA_MISSING` (the same refusal as REPAIR-014). This covers "db-meta and
     pgdata both deleted".
   - **Backend (after migrations, before `listen`):** `verifyDataAgainstManifest()` compares current counts to
     `lastKnownCounts`. A **severe drop** is: any of `invoices`, `parties`, `rolls`, `ledgerEntries` decreasing
     by more than **max(20 rows, 10%)** since the last verification. *(Thresholds PROPOSED — §19 Q16.)* On a severe
     drop the backend starts in **SAFE_MODE**: every mutating route returns `503 {code:"DATA_SAFE_MODE"}`
     (reuse the install-gate middleware pattern in `install.gate.middleware.ts`), read routes work, and a new
     `GET /api/integrity/status` returns the comparison. The UI shows a full-screen recovery page with the
     comparison, the last backup time, the boot log path, and actions: "restore backup" (REPAIR-028),
     "open diagnostics", and "I understand — accept current data as the new baseline" (admin password required).
     The last action is logged as `event: "BASELINE_ACCEPTED"`.
4. **Legitimate decreases** (cancellations do not delete rows; deletes are rare — parties are soft-cancelled) are
   not expected to trigger. Row counts are monotonic in normal use because the ledger is append-only and
   documents are cancelled rather than deleted. The rows that can legitimately be removed (sync outbox
   retention, REPAIR-017) are excluded from the checked set.
5. **Exceptions:**
   - First install: no manifest → no check; the manifest is created after the first successful boot.
   - Factory reset: the in-app request (`requestFactoryReset`, `stack.rs:305`) sets
     `resetAuthorized = true` **only after** the user confirms with the admin password (new backend endpoint
     `POST /api/integrity/authorize-reset`); after a reset, the next boot writes a fresh manifest with
     `resetAuthorized=false`.
   - Restore: REPAIR-028 sets `restoreInProgress = { operationId, expectedCounts }`; the next verification compares
     against `expectedCounts` instead of `lastKnownCounts`.

Files To Modify: new `backend/src/infrastructure/integrity/dataIntegrityManifest.ts`; new
`backend/src/infrastructure/http/middleware/dataSafeMode.middleware.ts`; new route
`backend/src/presentation/routes/integrity.route.ts`; `backend/src/presentation/server.ts` (wire before
`listen`); `backend/src/infrastructure/config/env.ts` (`DATA_INTEGRITY_PATH`); `desktop/src-tauri/src/db_meta.rs`
(read manifest); `desktop/src-tauri/src/runtime/stack.rs` (env var, factory reset authorization check); new UI
`src/components/integrity/DataSafetyScreen.tsx` mounted from `src/components/auth/AuthGate.tsx` (or the
activation gate) when `/api/integrity/status` reports `safeMode`.

Files Not To Change: business repositories; migrations; `secret_store.rs`.

Invariants to preserve: first install and a normal boot must not become slower by more than one count query
(< one extra round trip); read-only behaviour in SAFE_MODE must not write anything (not even audit logs; the
integrity event goes to the log file).

API Changes (additive): `GET /api/integrity/status`, `POST /api/integrity/authorize-reset`,
`POST /api/integrity/accept-baseline` (admin).

Tests To Add:
- Backend unit: `evaluateDrop(prev, now)` table-driven (no drop / small drop / 10% drop / below-20 absolute /
  first run).
- Backend integration (live PG): seed 100 invoices → write manifest → delete 50 in the test DB → boot check →
  SAFE_MODE, mutating route returns 503, GET works.
- Rust: manifest present + no pgdata → `DATA_MISSING`; manifest `resetAuthorized=true` → Fresh.
- Frontend: SafeMode screen renders the comparison (pure view-model test).

Verification: `VERIFY-ALL`; manual on a copy of real AppData (REPAIR-030 scenario S-6).

Success Criteria: all rows of the §5.1 coverage table that reference 023 behave as stated.

Regression Risks: false positives (mitigated by the absolute+relative threshold and admin override); manifest
corruption (JSON parse failure → treated as "no manifest", **logged as `MANIFEST_UNREADABLE`**, and never
blocks first install).

Rollback: remove the middleware wiring; the manifest file is inert.

Open Questions: §19 Q16 (thresholds), Q17 (which tables are checked).

---

## REPAIR-014 — Fail closed when data is missing but the installation had data

Status: CONFIRMED

Category: Desktop data lifecycle

Severity: CRITICAL

Evidence: `db_meta.rs:135-137` returns `Fresh` whenever `pgdata/PG_VERSION` is missing. `stack.rs:349-369`
copies the empty template, and `stamp_fresh_cluster` overwrites `db-meta.json`. Factory reset deletes both
`pgdata` and `db-meta.json` (`stack.rs:296-299`), so "meta present, pgdata missing" never results from a
legitimate reset.

Technical Repair: in `evaluate_existing_cluster`:
- `PG_VERSION` missing **and** (`read_meta()` = `Some(meta)` with `meta.schema_journal_idx > 0` **or** the
  REPAIR-023 manifest shows business rows) → return `Err(DataMissing)` with this Arabic message: "مجلد قاعدة
  البيانات مفقود رغم أن هذا الجهاز كان يحتوي بيانات. لن يُنشأ نظام فارغ تلقائياً. الخيارات: استعادة نسخة احتياطية
  — تحديد مجلد البيانات القديم — إعادة ضبط مصنعي مؤكدة."
- Emit event `DATA_MISSING` (REPAIR-013).
- The fatal dialog gains three buttons (Tauri commands already exist for factory reset; add
  `open_data_folder` and `choose_existing_pgdata` which copies a user-selected folder into `pgdata` **only after**
  the REPAIR-025 fingerprint check passes on it).

Files To Modify: `desktop/src-tauri/src/db_meta.rs`, `runtime/stack.rs` (dialog buttons),
`runtime/mod.rs` (commands), `src/infrastructure/tauri-bridge.ts` (command wrappers, if the UI invokes them).

Tests: Rust — (a) no pgdata + no meta + no manifest → Fresh; (b) no pgdata + meta idx>0 → DataMissing;
(c) no pgdata + manifest with rows → DataMissing; (d) after factory reset (meta and manifest cleared, or
`resetAuthorized`) → Fresh.

Success Criteria: it is impossible to reach FRESH_TEMPLATE on a machine that previously had business data,
unless a confirmed reset happened.

Open Questions: §19 Q8 (whether "start empty anyway" exists; recommended: only through a confirmed factory reset).

---

## REPAIR-024 — Automatic pre-operation snapshot

Status: CONFIRMED (absence)

Category: Data safety

Severity: CRITICAL

Evidence: `runDesktopMigrations.ts:156-157` runs `repairLegacyLicenseTenantPairing` and `migrate()` directly;
`apply_requested_factory_reset` (`stack.rs:285-303`) deletes `pgdata` without a copy;
`restore-from-backup.mjs` deletes tenant rows without a copy. No snapshot code exists (`rg snapshot` finds none
in the runtime or the migration path).

Technical Repair:
1. **Where snapshots are taken:**
   - (a) before `migrate()` whenever the journal has pending entries (`lastJournalIdx(folder) > meta.schema_journal_idx`);
   - (b) before the legacy repair (`repairLegacyLicenseTenantPairing`);
   - (c) before a factory reset;
   - (d) before any restore;
   - (e) before an installer upgrade replaces `resources/` (optional; handled by (a) on first boot of the new version).
2. **How (desktop):** migrations (a) and the legacy repair (b) run while PostgreSQL is **up**, so a folder copy is
   not consistent there. Use **`pg_dump -Fc`** of the `erp` database. **Verified gap:** the desktop bundle does
   **not** ship `pg_dump.exe` / `pg_restore.exe` today — `desktop/src-tauri/resources/postgres/bin` contains only
   `createdb, initdb, pg_ctl, postgres, psql` (+ DLLs), and `desktop/scripts/resource-manifest.json` requires only
   `postgres.exe, pg_ctl.exe, initdb.exe`. Step 0 of this repair is therefore: stage `pg_dump.exe` and
   `pg_restore.exe` from the same PostgreSQL 17 distribution into `resources/postgres/bin` (their DLL
   dependencies `libpq.dll`, `libzstd.dll`, `liblz4.dll`, `libcrypto/libssl` are already present — confirm with
   `dumpbin /dependents`), add both to `resource-manifest.json` so `validate-resource-manifest.mjs` fails the build
   if they are missing, and confirm `prune-postgres.mjs` does not remove them. Write the dump into
   `%LOCALAPPDATA%\motard-erp\snapshots\<UTC-timestamp>_<operation>_<operationId>.dump`, with a sidecar JSON:
   `{ operationId, operation, createdAt, schemaJournalIdx, tenantId, databaseSizeBytes, rowCounts, sha256 }`.
   For (c), when the cluster is not running, copy the `pgdata` directory as a folder snapshot instead (a
   directory copy of a *stopped* cluster is consistent).
3. **Immutability:** after writing, set the file read-only (`attrib +R` / `set_readonly(true)`); the retention job
   is the only code allowed to remove it.
4. **Retention:** keep the last 5 snapshots **and** any snapshot younger than 30 days. *(PROPOSED — §19 Q18.)*
   Never delete the newest snapshot. If free disk space is below 2× the database size, refuse the operation
   (log `SNAPSHOT_FAILED`) instead of continuing without a snapshot.
5. **Failure rule:** if the snapshot fails, the dangerous operation **does not run** (migration refused with a
   `[FATAL]` reason; reset refused; restore refused).
6. **Hub (Neon):** out of scope for automatic snapshots (Neon has point-in-time restore). Document the manual
   pre-migration step in the release checklist: create a Neon branch before running migrations.

Files To Modify: `desktop/src-tauri/resources/postgres/bin/` (+ `pg_dump.exe`, `pg_restore.exe`), `desktop/scripts/resource-manifest.json` (require them); new `backend/src/infrastructure/integrity/snapshot.ts` (pg_dump invocation, checksum, sidecar);
`runDesktopMigrations.ts` (call before migrate/repair); `desktop/src-tauri/src/runtime/stack.rs` (factory-reset
folder snapshot); `backend/scripts/restore-from-backup.mjs` (call before DELETE); `desktop/scripts/prune-postgres.mjs`
(read-only check that `pg_dump.exe` and its DLLs are kept — change only if they are pruned).

Tests:
- Backend integration: pending migration → snapshot file + sidecar exist, sha256 matches, `pg_restore --list`
  succeeds; snapshot failure (simulate an unwritable directory) → migrate is not called and a `[FATAL]` reason is
  raised.
- Rust: factory reset copies `pgdata` into `snapshots/` before deletion; low disk → refusal.

Success Criteria: no destructive or schema-changing operation can run without a verifiable snapshot taken
within the same boot.

Regression Risks: boot time on upgrade (one dump of the DB; acceptable once per upgrade); disk usage (retention).

Open Questions: §19 Q18 (retention), Q19 (whether snapshots also go off-device).

---

## REPAIR-015 — Stop the blind migration baseline (interim, immediate)

Status: CONFIRMED

Category: Schema integrity

Severity: HIGH

Evidence: `runDesktopMigrations.ts:8-13` and `138-154` insert **every** journal hash when
`hasTenants && drizzleRowCount === 0`, then `migrate()` applies nothing. The log text relies on
"ensureDesktopSchema must close gaps", but `ensureDesktopSchema.ts:1-11` is `@deprecated` and only calls
`runDesktopMigrations()`, so no gap-closing DDL exists.

Technical Repair (this item is the **interim** step; REPAIR-025 is the durable one):
- Replace the baseline branch with: take a snapshot (REPAIR-024) → log `SCHEMA_UNVERIFIED` → throw a startup
  failure whose `[FATAL]` reason says: "قاعدة بيانات قديمة بلا سجل هجرات — لن تُعلَّم الهجرات كمطبّقة دون تحقق.
  نسخة أمان محفوظة في: <path>. تواصل مع الدعم أو استخدم أداة التحقق من المخطط."
- Keep `shouldBaselineExistingCluster()` as a pure predicate (tests use it), but only REPAIR-025 may baseline,
  and only when the full fingerprint matches.

Files To Modify: `backend/src/infrastructure/orm/runDesktopMigrations.ts`; update
`backend/tests/run-desktop-migrations.test.ts`.

Tests: legacy cluster without history → throws, snapshot exists, no rows are inserted into
`drizzle.__drizzle_migrations`; normal history → unchanged.

Success Criteria: `drizzle.__drizzle_migrations` is never written by application code.

---

## REPAIR-025 — Full schema fingerprint verification (replaces sentinels)

Status: CONFIRMED (absence)

Category: Schema lifecycle

Severity: HIGH

Evidence: `backend/tests/schema-migration-parity.test.ts` checks only that declared columns are created by
*some* migration; indexes, constraints, RLS policies, triggers, functions, defaults, and enums are not compared.
REPAIR-020 found a real index drift. The review correctly notes that sentinel columns cannot prove that the
intermediate migrations ran.

Technical Repair:
1. **Build-time manifest generator** `backend/scripts/schema-fingerprint.mjs`:
   - Applies all migrations to a disposable DB (reuse `ensure-test-db.mjs` logic with a unique DB name), then
     reads the catalog and writes `backend/src/infrastructure/orm/migrations/meta/schema-fingerprint.json`:
     ```
     { journalIdx, generatedAt,
       tables:   { name: { columns: { name: { type, nullable, default } } } },
       indexes:  { name: { table, definition } },          // pg_indexes.indexdef
       constraints: { name: { table, type, definition } }, // pg_get_constraintdef
       policies: { "table.policy": { cmd, using, withCheck } },
       rls:      { table: { enabled, forced } },
       triggers: { name: { table, definition } },          // pg_get_triggerdef
       functions:{ name: sha256(prosrc) },
       enums:    { name: [labels] },
       extensions: [name] }
     ```
     plus `sha256` of the canonical JSON.
   - CI step: regenerate and fail if it differs from the committed file, so every migration change updates the
     fingerprint in the same commit.
2. **Runtime verifier** `backend/src/infrastructure/orm/schemaFingerprint.ts`: `readLiveFingerprint(pool)` (same
   queries) and `diffFingerprint(expected, live)` returning `{ missing, extra, changed }` per category.
3. **Where it runs:**
   - After `migrate()` on every desktop boot: a mismatch in `missing`/`changed` → `SCHEMA_UNVERIFIED` refusal
     with the diff summary; `extra` objects are logged only (a customer DB may have extra indexes).
   - In the legacy branch (no drizzle history): baseline **only** if the diff is empty; otherwise refuse
     (REPAIR-015 behaviour).
   - As a CLI for support: `node backend/scripts/verify-schema.mjs --url <db>` prints the diff (read-only).
4. The fingerprint is bundled with the desktop build (it sits in the migrations folder that is already shipped via
   `DESKTOP_MIGRATIONS_FOLDER`).

Files To Modify: new `backend/scripts/schema-fingerprint.mjs`, new `backend/scripts/verify-schema.mjs`, new
`backend/src/infrastructure/orm/schemaFingerprint.ts`, `runDesktopMigrations.ts`, CI workflow
`.github/workflows/ci.yml` (add the regenerate-and-diff step), new committed
`migrations/meta/schema-fingerprint.json`.

Files Not To Change: existing migration SQL files.

Tests: unit tests for `diffFingerprint` (missing index, changed policy, extra index ignored); an integration test
that the live `erp_test` fingerprint equals the committed file; the legacy baseline test from REPAIR-015 updated to
"baseline only when the diff is empty".

Success Criteria: every boot verifies the full schema; the fingerprint is regenerated by CI on every migration change.

Regression Risks: environment-dependent catalog text (collation, PostgreSQL major). Pin the PostgreSQL major in the
generator (the bundled 17) and normalise whitespace in definitions. Neon (hub) may differ in extensions and role
names, so the hub runs the verifier in report-only mode.

Open Questions: §19 Q20 (hub strictness).

---

## REPAIR-026 — Tenant and data-visibility consistency check

Status: CONFIRMED (absence of a check); the defect itself is NOT PROVEN

Category: Data safety / identity

Severity: HIGH

Evidence: tenant id sources are `localStorage erp.install.tenantId` (`src/lib/license-state.ts`),
`VITE_DEFAULT_TENANT_ID` (`desktop/build-frontend.cmd:19` = `407fccfc-…`), the JWT `tenantId`,
`BOOTSTRAP_TENANT_ID` (server env), and `tenants.slug='default'` (desktop auth). The desktop server forces the
`default` slug (`auth.route.ts` `DESKTOP_DEPLOY` branches). The user's log has 6 `JWSSignatureVerificationFailed`
entries (a token from a previous secret), a symptom that a client can hold stale identity.

Technical Repair:
1. Backend, at boot after migrations: resolve the **effective tenant** (`slug='default'` on desktop,
   `BOOTSTRAP_TENANT_ID ?? findAnyCompleted()` on the hub), count business rows per tenant with
   `SELECT tenant_id, count(*) FROM invoices GROUP BY tenant_id` (plus parties and rolls) under platform context,
   and log `TENANT_SELECTED {tenantIdPrefix, rows}`. If **another** tenant holds business rows while the
   effective tenant holds none → log `TENANT_MISMATCH` and enter SAFE_MODE (REPAIR-023) with a diagnostic
   listing both tenants' counts.
2. Frontend: on login, compare the JWT `tenantId` with `erp.install.tenantId`. If they differ, overwrite the stored
   value with the JWT's (the server is authoritative) and log it once to the console; if the manifest tenant
   (REPAIR-023) differs from the effective tenant, the server reports it via `/api/integrity/status`.
3. Manifest: store `tenantId`; a change of effective tenant between boots is `TENANT_MISMATCH` unless a restore or
   a reset was authorized.

Files To Modify: `backend/src/infrastructure/integrity/dataIntegrityManifest.ts` (tenant section),
`backend/src/presentation/server.ts` (boot check), `src/presentation/hooks/useAuth.ts` (`useLogin`,
`useCurrentUser` success path) or `src/lib/license-state.ts` (reconcile helper).

Tests: integration — DB with two tenants where only the non-effective one has invoices → SAFE_MODE with
`TENANT_MISMATCH`; single tenant → normal.

Success Criteria: "data exists but login cannot see it" always produces a visible diagnostic instead of an empty app.

---

## REPAIR-028 — Backup and restore correctness, automation, and drills

Status: CONFIRMED

Category: Data safety / operations

Severity: CRITICAL

Evidence:
- `backend/src/presentation/routes/backup.route.ts:207-243`: failed table dumps become `[]` + `warnings`; lines
  80-97 stream the ZIP with HTTP 200 regardless.
- `backend/scripts/restore-from-backup.mjs`: never reads `warnings`; line 262 `DELETE FROM "${t}" WHERE tenant_id = $1`
  for every table, then inserts the dump, so a failed table is wiped. It prints before/after counts (line 16),
  but does not compare them to the dump.
- No automatic backup (`rg setInterval|cron|schedule` → only the hub probe in `server.ts:534`).
- Restore is a developer script; there is no in-app restore and no restore drill.

Technical Repair:
**A. Backup must never be "successful" with warnings.**
1. `backup.route.ts`: after `writeDatabaseDump`, if `warnings.length > 0` → respond **HTTP 500**
   `{ code: "BACKUP_INCOMPLETE", warnings }`, delete the partial ZIP, and do not update
   `lastSuccessfulBackupAt`.
2. Add `metadata.json` in the ZIP: `{ operationId, tenantId, schemaJournalIdx, createdAt, rowCounts (per table),
   sha256 of database.json, appVersion, syncState: { lastPullSeq, outboxPending, outboxPushing } }`.
3. On success, update the REPAIR-023 manifest `lastSuccessfulBackupAt`.

**B. Automatic backup (desktop).**
4. A backend scheduler (desktop only): daily at the first idle moment after 02:00 local time, or at boot if the
   last success is older than 24 h. It writes to `%LOCALAPPDATA%\motard-erp\backups\` (local copy) and to an
   optional second location configured in settings (off-device: a USB/network folder).
   *(Schedule, retention, and off-device target are PROPOSED — §19 Q19.)*
5. Retention: 7 daily + 4 weekly + 12 monthly (PROPOSED). Encryption: AES-256-GCM with a key derived from
   `secrets.dat` (the existing DPAPI-protected store) — **only if** Q19 approves; otherwise document that local
   backups are protected by the user's Windows ACL only.
6. Failures: a failed automatic backup creates a persistent notification (existing notifications table) and a
   header badge until the next success.

**C. Restore must be verified and non-destructive until proven.**
7. `restore-from-backup.mjs` (and a future in-app restore that reuses it):
   - Refuse if `database.json.warnings.length > 0` (unless `--allow-incomplete` **and** the listed tables are
     excluded from the DELETE phase).
   - Verify `metadata.json` sha256 and `schemaJournalIdx` ≤ the target's (and equal after migration).
   - Take a snapshot (REPAIR-024) before the DELETE phase.
   - Run the whole restore in **one transaction** (the script currently issues statements on one client; wrap
     them in `BEGIN … COMMIT` so any failure rolls back to the pre-restore state).
   - After inserting, compare per-table counts with `metadata.rowCounts`; on any mismatch → `ROLLBACK`.
   - Verify: tenant id, `sync_state` cursor (existing clamp logic), pending outbox count, attachments present on
     disk for every `attachments` row, and uploads copied.
   - Set the REPAIR-023 `restoreInProgress` marker so the next boot verifies against the restored counts.
8. **Restore drill:** script `backend/scripts/restore-drill.mjs`: creates a disposable DB, runs migrations,
   restores the latest backup into it, runs the verifications, and prints a pass/fail report. Recommended
   monthly and before every release (release checklist item).

**RPO / RTO:** with daily backups, RPO ≤ 24 h of local work (sync-paired devices also have the hub copy); RTO
target = restore-drill duration measured on the largest real backup. **Both are PROPOSED targets; §19 Q19.**

Files To Modify: `backend/src/presentation/routes/backup.route.ts`; new
`backend/src/infrastructure/backup/backupScheduler.ts`; `backend/scripts/restore-from-backup.mjs`; new
`backend/scripts/restore-drill.mjs`; `src/routes/settings.backup.tsx` (show `BACKUP_INCOMPLETE`, last success,
schedule, second location); `backend/src/presentation/server.ts` (start the scheduler on desktop).

Files Not To Change: table list semantics in `backup.route.ts` (keep every table currently included, including
sync tables — see the file's own comments).

Tests:
- Backend integration: force one table's dump to fail (e.g. revoke SELECT in a test role, or inject a failing
  query through a test seam) → HTTP 500 `BACKUP_INCOMPLETE`, no ZIP left behind.
- Restore: dump with warnings → refused; count mismatch → rolled back and target unchanged; happy path → counts
  equal `metadata.rowCounts`, cursor clamp preserved (existing `tests/restore-sync-state.test.ts` stays green).
- Drill script: exits non-zero on any verification failure.

Success Criteria: no backup with warnings is ever reported as successful; no restore can leave a tenant with
fewer rows than the backup declared.

Open Questions: §19 Q19 (schedule, retention, encryption, off-device target, RPO/RTO).

---

# PHASE 1 — Correctness

---

## REPAIR-004a — Dashboard cash: stop blending currencies

Status: CONFIRMED

Category: Correctness (financial display)

Severity: HIGH

Evidence: `backend/src/infrastructure/repositories/PostgresDashboardRepository.ts:558-572` (no-cash-session
branch) sums `cashImpact in/out` ledger legs with **no `currency` predicate** into one `cashBalance`, which blends
SYP, USD and EUR. The session branch (510-557) filters by `cashSession.currency` but re-implements the cash
formula and loads all manual movements into Node (REPAIR-005). The authoritative helper is
`getCashboxBalanceAsOf` (`cashboxBalanceHelper.ts:91-114`, reading `cashbox_daily_balances`).

Business semantics to preserve: cash = opening + ledger cash in − out + manual in − out, **per currency**
(project rule; see the BUG-06 comments in `src/routes/reports.$slug.tsx`).

Technical Repair:
1. Replace both branches with a per-currency map built from `getCashboxBalanceAsOf(tx, ctx, ccy, today)` for each
   currency in `{session currency} ∪ {currencies with cash legs or manual movements}` (one `SELECT DISTINCT currency`
   query each).
2. DTO (additive): `cashBalanceByCurrency: Record<string, number>`. The existing scalar `cashBalance` keeps its
   meaning in the session branch (= session currency). In the no-session branch it becomes **the SYP balance**
   or `null` — **contract decision, §19 Q3**. The blended sum must not survive.
3. Frontend: render the map where the dashboard shows cash (`src/components/dashboard/*`, find the consumer with
   `rg cashBalance src`).

Files To Modify: `PostgresDashboardRepository.ts` (cash section only), `backend/src/domain/entities/Dashboard.ts`
(additive field), `src/contracts/dashboard.ts`, the dashboard cash card component.

Files Not To Change: `cashboxBalanceHelper.ts` (reuse only), cashbox migrations and triggers.

Tests: integration — no cash session, SYP legs +1,000,000 and USD legs +100 → `cashBalanceByCurrency =
{SYP: 1000000, USD: 100}` and the scalar is never 1,000,100; with a session → scalar equals
`getCashboxBalanceAsOf(session currency)`.

Success Criteria: no dashboard figure mixes currencies.

Rollback: revert the file (the additive DTO field is harmless).

---

## REPAIR-008 — Financial idempotency: close the gaps, then make it durable

Status: CONFIRMED (part A) / DESIGN (part B)

Category: Financial safety

Severity: HIGH

Evidence:
- The middleware is optional by design (`idempotency-handler.middleware.ts:30-31`) and is a **5-minute HTTP retry
  guard only** (`idempotency.middleware.ts:40-46`, `IDEMPOTENCY_TTL_SECONDS = 300`).
- First-party client: `BaseHttpClient.ts:60-81` sends one key per logical request, reused across retries.
- Financial POST routes **without** middleware: `statement.route.ts:115` (`settle-invoices`, creates N vouchers
  and moves cash), `statement.route.ts:209` (`settle`), `ledger.route.ts:196` (`POST /ledger`).
- Durable dedupe exists only for sync (`(tenant_id, op_id)` unique on `sync_outbox`/`sync_inbox`) and through
  `preAllocatedId` on replayed documents.

**Part A (Phase 1, mandatory):**
1. Add `idempotency("POST")` to the three routes, in the same middleware position as `voucher.route.ts:107`.
2. Make the key **required** (HTTP 428 `IDEMPOTENCY_KEY_REQUIRED`) on these financial mutations: `POST /invoices`,
   `PUT /invoices/:id`, `POST /receipts`, `POST /payments`, `POST /returns`, `POST /expenses`,
   `POST /cashbox/manual-movements`, `POST /cashbox/opening`, `POST …/settle-invoices`, `POST …/settle`,
   `POST /ledger`. Add a `required: true` option to `idempotency(method, { required })`.
   - **Exempt:** sync replay (it does not go through these HTTP routes; the hub materializes via use cases), and
     internal calls. **Check before enabling:** `rg "fetch\(|client\.post\(" src` shows every first-party caller
     goes through `BaseHttpClient` — verified for invoices/vouchers/returns/expenses/cashbox/settle. Any script under
     `backend/scripts` or `tests/e2e` that POSTs to these routes must send a key (update them in the same change).

**Part B (design; needs §19 Q13):** a durable business operation id.
3. Column `client_operation_id uuid` (nullable) on `invoices`, `vouchers`, `returns`, `expenses`,
   `manual_movements`, `ledger_entries` (batch header), plus a partial unique index
   `(tenant_id, client_operation_id) WHERE client_operation_id IS NOT NULL`. The middleware passes the
   Idempotency-Key into the use case as `clientOperationId`. A duplicate after the 5-minute TTL then hits the unique
   index; the repository catches `23505` on that index and returns the existing row (the same response contract as
   the cache).
4. Why it is split out: it changes six tables and every create path, and it only matters for non-first-party or
   long-delayed retries. Decide it after Part A.

Files To Modify (A): `backend/src/infrastructure/http/middleware/idempotency-handler.middleware.ts` (`required`
option), `statement.route.ts`, `ledger.route.ts`, the routes listed above (flag only); scripts/e2e callers that
omit the key.

Files Not To Change (A): repositories; the middleware storage format.

Tests (A): same key twice on `settle-invoices` → one set of vouchers and one cash movement; missing key on a
required route → 428; `BaseHttpClient` flows (existing e2e) unaffected.

Success Criteria (A): no financial POST route can be executed twice by a retried request with the same key; no
financial POST route accepts a request without a key.

Regression Risks: third-party scripts without keys start failing (intended; documented in release notes).

---

## REPAIR-009 — Money precision policy (validate new input; never break old replay)

Status: PARTIALLY CONFIRMED

Category: Precision

Severity: MEDIUM (0.01 drift between stored components and stored total; the ledger stays balanced because it posts `total`)

Evidence: `packages/shared/src/schemas/invoice.schema.ts` validates `quantityKg`, `pricePerKg`, and
`creditApplied` with `is2dp`, but not header `discount`, `tax`, `shipping`, `paid`, or line `discountAmount`
(line 43). `round2dp` = `Math.round(n*100)/100` (`packages/shared/src/precision.ts:23`); columns are
`numeric(14,2)` (PostgreSQL rounds half away from zero on store). Worked example: subtotal 100, discount 0.005 →
`total = 100.00`, stored discount 0.01 → `subtotal − discount = 99.99 ≠ total`.

Domain formula (verified; this is what any invariant must use):
`lineTotal = round2dp(qty × price − lineDiscount)`; `subtotal = round2dp(Σ lineTotal)`;
`total = round2dp(subtotal − discount + tax + shipping)` (`packages/shared/src/entities/Invoice.ts:47-58`).
All three currencies (SYP/USD/EUR) use 2 dp today. There are no negative money fields (schemas use `.min(0)` /
`.positive()`).

Technical Repair (ordered; steps 1–2 are prerequisites):
1. **Data audit (read-only script)** `backend/scripts/audit-precision.mjs`: count rows where any money column of
   `invoices`, `invoice_lines`, `vouchers`, `returns`, `expenses` has more than 2 decimals **in the original
   inputs** — i.e. scan `sync_outbox.payload` / `sync_inbox.payload` `createInput` JSON for values with more than 2
   decimals. Run it on the hub and on at least one real desktop copy.
2. **Official rounding convention (§19 Q6):** half-up at 2 dp at the input boundary, computed with
   `Math.round((n + Number.EPSILON) * 100) / 100` so that JS agrees with PostgreSQL on values like 1.005
   (PostgreSQL gives 1.01; plain `Math.round(1.005*100)/100` gives 1.00).
3. **Validation for new input only:** add `.refine(is2dp)` to `discount`, `tax`, `shipping`, `paid`, and
   `discountAmount` in `createInvoiceSchema` and `updateInvoiceSchema`; check `voucher.schema.ts`, `return.schema.ts`,
   and `expense.schema.ts` for the same fields and apply the same rule.
4. **Replay must not break:** sync materialization must **not** re-validate historical payloads with the stricter
   schema. Verify how `syncMaterialize.ts` validates `createInput` (if it calls the shared Zod schema, pass historical
   units through a normaliser `normalizeMoney2dp(createInput)` that rounds instead of rejecting, and log
   `PRECISION_NORMALIZED` with the op id).
5. **Persisted invariant (test, not a DB constraint):** after persistence
   `round2dp(subtotal − discount + tax + shipping) = total`, where `subtotal` is the stored column (itself defined as
   `round2dp(Σ lineTotal)`). Do **not** add a CHECK constraint: historical rows may legitimately violate it by 0.01.

Files To Modify: `packages/shared/src/precision.ts` (EPSILON-safe `round2dp`; audit all callers — it is used in
FX closure logic, so run the full FX suites), `packages/shared/src/schemas/{invoice,voucher,return,expense}.schema.ts`,
`backend/src/application/use-cases/sync/syncMaterialize.ts` (normaliser, only if step 4 finds validation there);
new `backend/scripts/audit-precision.mjs`.

Files Not To Change: `packages/shared/src/fx.ts` settlement rules (only through `round2dp` if the EPSILON change is
approved — see risk).

Tests: `is2dp` rejections for each field; replay of a historical payload with 3 dp succeeds (normalised);
property test over random 2-dp inputs: persisted invariant holds; the FX suites (`fx-exact-closure`,
`voucher-exact-invoice-closure`, `cross-currency-settlement`) stay green.

Regression Risks: **changing `round2dp` affects FX exact-closure maths.** If Q6 rejects the EPSILON change, keep
`round2dp` as is and apply only the validation (steps 3–5).

Open Questions: §19 Q6.

---

## REPAIR-010 — Party status "موقوف" (inactive) silently dropped

Status: CONFIRMED

Category: API contract bug

Severity: MEDIUM

Evidence: the UI offers `inactive` (`src/components/parties/PartyFormDialog.tsx:286-294`; filter in
`PartyTable.tsx:93,279`; types `src/domain/entities/Party.ts:6`, `src/contracts/customers.ts:24`); the client sends
it (`ApiPartyRepository.ts:93-100`); the backend repository would persist it (`PostgresPartyRepository.ts:346`).
**But `createPartySchema` (`packages/shared/src/schemas/party.schema.ts:4-40`) has no `status`, so Zod strips it**,
and `listPartiesSchema.status` is `z.enum(["active","cancelled"])` (line 45).

Technical Repair: `status: z.enum(["active","inactive"]).optional()` in `createPartySchema` (hence
`updatePartySchema`); `listPartiesSchema.status: z.enum(["active","inactive","cancelled"])`. `cancelled` stays
reachable only through DELETE. Party sync enqueue carries the snapshot, so verify `findSyncSnapshot` includes
`status`.

**Behavioural decision (§19 Q7):** whether an inactive party stays selectable in new documents. This repair does
**not** change picker filtering; it only makes the saved value stick.

Tests: PUT `status: "inactive"` persists and syncs; list `?status=inactive` works; POST without status still defaults to `active`.

---

## REPAIR-011 — Frontend ledger / invoice types match the backend

Status: CONFIRMED (types only)

Severity: LOW

Evidence: `src/domain/types/index.ts:51-61` `LedgerType` lacks at least `cogs_expense`
(`PostgresInvoiceRepository.ts:1200`), `fx_gain`, `fx_loss`, `settlement_discount_expense`,
`settlement_discount_income`, `sales_return_contra`, `purchase_return_contra`, `adjustment_contra`, `cash`,
`printing_charge`, `cancellation`. `src/contracts/invoices.ts:19,44` and `src/domain/entities/Invoice.ts:32` allow
`"return"`, which no backend path accepts.

Technical Repair: build the union from the exact set of `type:` literals written into `ledgerEntries` (search:
`rg -o 'type: "[a-z_]+"' backend/src/infrastructure/repositories backend/src/application | sort -u`), cross-check
against the ledger type CHECK constraint (`tests/ledger-entry-types.test.ts` enumerates it), and add a test that
the frontend union equals that list. Remove `"return"` from invoice types after `rg '"return"' src` shows no branch
depends on it.

Files To Modify: `src/domain/types/index.ts`, `src/contracts/invoices.ts`, `src/domain/entities/Invoice.ts`, new
`src/domain/types/ledgerTypes.test.ts`.

---

## REPAIR-021 — Cashbox naming and comments reflect the real rule

Status: CONFIRMED

Severity: LOW

Evidence: `assertSufficientCashboxBalance` asserts nothing (it returns `{available, wouldGoNegative}`; callers
ignore it by design); `PostgresCashboxRepository.ts:106-108` says "F06: cash-out must never take the cashbox
negative", which contradicts the rule stated in `cashboxBalanceHelper.ts:116-121`.

Technical Repair: rename to `lockAndReadCashboxBalance`, keep `assertSufficientCashboxBalance` as a
`@deprecated` re-export for one release, and fix the comment. No behaviour change.

Tests: `tsc`; the existing cashbox suites.

---

# PHASE 2 — Concurrency and synchronization

---

## REPAIR-007 — Atomic outbox claim and a real per-tenant run lock

Status: CONFIRMED

Category: Synchronization correctness

Severity: HIGH

Evidence: `PostgresSyncOutboxRepository.ts:74-99` `listClaimable` is a plain `SELECT … ORDER BY seq LIMIT n`;
`markPushing` (101-109) is a separate `UPDATE`; `runLocalSyncPush` calls them back to back. `/sync/run`
(`sync.route.ts`) has no server-side lock (`rg advisory|mutex|inFlight` in the sync code finds nothing). The only
guard is the per-tab `running` flag in `src/lib/sync-engine.ts`. Concurrent runs are realistic: two windows, two
users on one desktop, the 20-second periodic run plus a manual run, or the hub's own traffic.

Sync-specific context:
- Mutation origin: any local write, enqueued in the same transaction (`enqueueSyncUnit`).
- Ordering: lane 0 (`ORDERED_LANE_TYPES`) must stay in global `seq` order; document lanes keep per-document order.
- Delivery semantics (must be preserved and stated correctly): **at-least-once delivery + idempotent
  materialization keyed by `(tenant_id, op_id)`** — not exactly-once end to end.
- Crash recovery: a lease-expiry reclaim of `pushing` rows.

Technical Repair:
1. `claimBatch(tenantId, limit, leaseMs, owner)`, one statement (it also carries the REPAIR-027 columns):
   ```sql
   UPDATE sync_outbox o
      SET status = 'pushing', lease_owner = $owner, lease_token = gen_random_uuid(),
          lease_until = now() + ($leaseMs || ' milliseconds')::interval, claimed_at = now(), updated_at = now()
    WHERE o.id IN (
          SELECT id FROM sync_outbox
           WHERE tenant_id = $tenant
             AND (status = 'pending' OR (status = 'pushing' AND lease_until < now()))
           ORDER BY seq
           LIMIT $limit
           FOR UPDATE SKIP LOCKED)
   RETURNING o.*;
   ```
   Sort the returned rows by `seq` in JS (`RETURNING` order is not guaranteed). `gen_random_uuid()` is built in from
   PostgreSQL 13 (bundled 17; Neon ≥ 14).
2. **Run lock** (all of these are required):
   - Acquire `pg_try_advisory_lock(hashtextextended($tenant || ':sync-run', 0))` on a **dedicated client**
     checked out with `pool.connect()` and **held for the whole run**. The run's own queries use the normal pool.
     Never take the lock through `db.execute` (that returns the connection to the pool and silently releases or
     leaks the lock).
   - If not acquired → return the existing `{ skipped: true, reason: "sync already running" }` shape (the frontend
     already handles it).
   - `finally`: `pg_advisory_unlock` and then `client.release()`. On process crash PostgreSQL releases session
     locks when the connection closes; the lease (REPAIR-027) covers rows claimed before the crash.
   - Scope: **tenant** on the device (one local backend serves one tenant). On the hub the run lock is not used
     (the hub does not run `/sync/run` for devices).
3. Replace `listClaimable`+`markPushing` in `runLocalSyncPush`. Keep `listClaimable` only if a read-only status view
   uses it (`rg listClaimable`).

Files To Modify: `PostgresSyncOutboxRepository.ts`, `ISyncOutboxRepository.ts`, `syncUseCases.ts`
(`runLocalSyncPush`), `sync.route.ts` (`/sync/run` lock), new migration (REPAIR-027 columns).

Files Not To Change: `receiveSyncPush`, `syncMaterialize.ts`, claims, conflicts.

Tests (live PG): two concurrent `claimBatch` calls on 100 pending rows return disjoint sets whose union is 100;
two concurrent `/sync/run` requests → exactly one runs and the other returns `skipped`; kill the process mid-run
(test: release the lock client without unlocking) → the lease expires → rows are reclaimed.

Success Criteria: in the concurrency test no unit is pushed twice by the same device.

---

## REPAIR-027 — Lease token and stale-worker protection

Status: CONFIRMED

Category: Synchronization correctness

Severity: HIGH

Evidence: `sync-outbox.table.ts:23-53` has no lease columns; the lease is `updated_at` + `DEFAULT_PUSHING_LEASE_MS`
(5 min, `PostgresSyncOutboxRepository.ts:18`). `markSynced` (111-118), `markRejected` (120-127), and
`resetToPending` (129+) filter by `id` + `tenant_id` only. A push that stalls for more than 5 minutes (hub
timeouts are 15 s per request, but a run can hold many) can be reclaimed by run B; when run A finally returns, it
overwrites B's outcome (e.g. marks `synced` a row B has reset to `pending` after a 409, or marks `rejected` a row B
synced) and may trigger `rollbackRejectedUnitLocally` twice.

Technical Repair:
1. Migration `<date>_sync_outbox_lease.sql`:
   `ALTER TABLE sync_outbox ADD COLUMN IF NOT EXISTS lease_owner text, ADD COLUMN IF NOT EXISTS lease_token uuid,
   ADD COLUMN IF NOT EXISTS lease_until timestamptz, ADD COLUMN IF NOT EXISTS claimed_at timestamptz;`
   Backfill: `UPDATE sync_outbox SET lease_until = updated_at + interval '5 minutes' WHERE status = 'pushing';`.
   Index: replace nothing; the claim uses `idx_sync_outbox_tenant_status_seq`. Declare the columns in
   `sync-outbox.table.ts`.
2. State transitions (the only allowed ones):
   `pending → pushing(owner, token, until)` (claim) → `synced` | `rejected` | `pending` (retryable) — **each final
   update is**
   ```sql
   UPDATE sync_outbox SET status = $next, …, lease_owner = NULL, lease_token = NULL, lease_until = NULL
    WHERE id = $id AND tenant_id = $tenant AND status = 'pushing' AND lease_token = $token
   ```
   and returns `rowCount`. `rowCount = 0` means the lease was lost: log `LEASE_LOST {opId}` and **skip every side
   effect** (in particular `rollbackRejectedUnitLocally`).
3. `lease_owner` = `<bootId>:<pid>:<runId>` (REPAIR-013 `bootId`) for diagnostics.
4. **Lease renewal:** the push loop extends `lease_until` for rows still in flight every 60 s (heartbeat update
   guarded by the token) so that a slow but healthy run is not reclaimed.
5. **Dead-letter reconciliation:** units the hub parks as `dead` (`hubDead`, `hubDeadOps` in `runLocalSyncPush`)
   are listed by a new read endpoint `GET /sync/dead` (admin) with op, entity, and hub reason, surfaced in
   Settings → المزامنة السحابية with a "retry after fix" action that resets the unit to `pending` with a new op id
   **only for idempotent entity types** (masters). Financial dead units are manual-resolution only (link to the
   document). *(Reconciliation workflow = §19 Q21.)*

Files To Modify: new migration + journal; `sync-outbox.table.ts`; `PostgresSyncOutboxRepository.ts` (token-guarded
`markSynced/markRejected/resetToPending`, `renewLease`); `ISyncOutboxRepository.ts`; `syncUseCases.ts` (pass tokens,
honour `rowCount = 0`); `sync.route.ts` (`/sync/dead`); `src/routes/settings.sync.tsx` (dead-unit list).

Tests (live PG):
- A claims → lease expires → B claims (new token) → A's `markSynced(tokenA)` returns 0 rows and the status stays
  B's; B's `markSynced(tokenB)` succeeds.
- A rejected unit whose lease was lost does **not** call the local rollback.
- Renewal keeps a slow run's rows from being reclaimed.
- Existing `sync-*` suites stay green (`sync-invariants.test.ts` string checks may need updating the same way as
  on 2026-09-23 — keep their intent).

Success Criteria: no final outbox status is ever written without the current lease token.

Rollback: the columns are nullable and additive; reverting the code restores the old behaviour.

---

## REPAIR-012 / REPAIR-019 — Deterministic resource lock order and batched roll locking

Status: CONFIRMED (mechanism) — deadlock frequency NOT MEASURED

Category: Transaction / concurrency (+ round-trip reduction)

Severity: MEDIUM

Evidence:
- Invoice create: `.for("update")` per line in input order (`PostgresInvoiceRepository.ts`, the loop
  `for (const line of input.lines)` ~267-281).
- Invoice update: `for (const rollId of rollIds)` (a `Set` in insertion order, ~858) with `SELECT … FOR UPDATE`
  (~859), a color check (~884), `UPDATE` (~966), and `recordStockMovement` (~978) — 3–4 round trips per roll.
- Return create: `inputByRoll` (a `Map` in input order) and `.for("update")` (`PostgresReturnRepository.ts:300-352`);
  further `.for("update")` at lines 593 and 615.
- Voucher create locks the invoice row (`PostgresVoucherRepository.ts` ~181-192) and, for cash payments, takes the
  cashbox advisory lock (`cashboxBalanceHelper.ts:130-131`).

Global lock order (to be documented in `docs/decisions.md` and followed by every mutation):
```
1. cashbox advisory lock (tenant:cashbox:ccy)   — only when cash moves
2. invoice row(s)                               — ORDER BY id
3. party row                                    — only where locked today
4. rolls                                        — ORDER BY id
5. document_sequences / number blocks           — existing allocateDocumentNumber
6. ledger / stock_movements / outbox inserts    — inserts only, no locks
```
(The current code takes the cashbox lock *before* inserting, and voucher create locks the invoice first. The order
above matches the existing voucher path. The implementing agent must verify each path against this order with
`rg '\.for\("update"\)|pg_advisory_xact_lock' backend/src` and fix only the ordering, never the checks.)

Technical Repair:
1. Helper `lockRollsOrdered(tx, tenantId, rollIds)`:
   `SELECT r.*, c.fabric_id FROM rolls r JOIN colors c ON c.id = r.color_id WHERE r.tenant_id = $1 AND r.id = ANY($2) ORDER BY r.id FOR UPDATE OF r`.
   - De-duplicate `rollIds` before the query (duplicate lines on the same roll are already aggregated by
     returns; invoice create must aggregate the same way before comparing stock).
   - If the result has fewer rows than the distinct ids → throw the **existing** "roll not found" business error
     for the first missing id (preserve the messages).
   - Tenant filtering is in the WHERE clause (plus RLS).
   - Return a `Map<id, row>`. The existing per-line validation (version check, color/fabric consistency, stock
     sufficiency, pieces) runs unchanged against the map.
2. Use it in invoice create, invoice update, return create, and any other roll-locking loop found by the search.
3. Batch `recordStockMovement` inserts into one multi-row insert when the helper allows it (read
   `stockMovementHelper.ts` first; if it computes `balanceAfterKg` per row sequentially, keep per-row inserts —
   correctness first).

Files To Modify: new `backend/src/infrastructure/repositories/rollLocking.ts`; `PostgresInvoiceRepository.ts`
(create/update loops only); `PostgresReturnRepository.ts` (lock section only); `docs/decisions.md` (lock order ADR).

Files Not To Change: ledger posting, COGS computation, stock-sufficiency rules, error texts.

Tests (live PG):
- Two transactions locking [A,B] and [B,A] through the helper complete without SQLSTATE 40P01 (run 50 iterations).
- A missing roll id produces the same error message as today.
- Duplicate roll ids in one invoice behave as today.
- Existing suites: `five-bug-fixes-regression`, `invoice-*`, `sale-cogs-*`, `roll-*`, `entry-cancel-consumed-stock`.

Success Criteria: all roll-locking paths lock in ascending id order in one statement.

---

# PHASE 3 — Data completeness and performance

---

## REPAIR-002 — Party balances report uses the server's ledger aggregation

Status: CONFIRMED

Category: Correctness (financial report)

Severity: HIGH

Evidence: `src/routes/reports.$slug.tsx:330-373` `PartyBalances`: `remainingOf(partyId)` loops over
`ledgerEntries` from `useLedgerEntries({ limit: 1000 })` (line 89, **tenant-wide, newest 1,000 rows**) for each
party, and `invoices.filter(...)` per party: O(P·G + P·I) on truncated data. Each sale writes 4–6 ledger rows, so
balances are wrong after roughly 200–300 invoices of activity.

Source of truth (verified): customer balance = Σ(debit − credit), supplier = Σ(credit − debit), per currency, over
**active** ledger rows of the party (`PostgresStatementRepository.getStatement`, `mult` rule lines 76-81; cancelled
rows are excluded from balances). The server already aggregates exactly this in
`PostgresPartyRepository.computeListStats` (lines 114-174, `GROUP BY partyId, currency`, `status = 'active'`).

Technical Repair:
1. Confirm (read-only) which query parameter makes the party list include stats and that `byCurrency` exposes the
   ledger-based remaining per currency (`partyListStatsAggregation.ts`). If `byCurrency` lacks the ledger balance,
   add `ledgerBalance` per currency (additive).
2. `PartyBalances` uses the paginated party list with stats; drop the `ledgerEntries` and `invoices` props.
3. Totals/paid per currency come from the same stats (invoice aggregation in `computeListStats`).

**Equivalence proof (required, per the review):** an integration test matrix asserting
`stats.byCurrency[c].ledgerBalance === statement(party, c).finalBalance` for every party × currency in a fixture
covering: customers and suppliers; SYP, USD, EUR; receipts and payments (linked and on-account); overpayment and
customer credit (2026-09-23 feature); sale and purchase returns; settlement discounts; cancellations (invoice,
voucher, return); opening balances (positive and negative); partial settlements; cross-currency settlements with
FX legs. Build the fixture with the real repositories, as `customer-statement-reconcile.test.ts` does.

Files To Modify: `src/routes/reports.$slug.tsx`; possibly `partyListStatsAggregation.ts` /
`PostgresPartyRepository.ts` (additive field).

Files Not To Change: `PostgresStatementRepository.ts`, ledger writers.

Success Criteria: the matrix passes; the report shows the same balance as each party's statement.

---

## REPAIR-001 — Remove every silent 1,000-row assumption

Status: CONFIRMED

Category: Correctness + frontend scalability

Severity: HIGH

Evidence: every list repository clamps `limit` to 1,000 and orders newest first:
`PostgresPartyRepository.ts:56,66`, `PostgresRollRepository.ts:46,56` (no status filter, so exhausted rolls count),
`PostgresFabricRepository.ts:35`, `PostgresColorRepository.ts:33`, `PostgresInvoiceRepository.ts:102,114`,
`PostgresVoucherRepository.ts:72`, `PostgresReturnRepository.ts:44`, `PostgresLedgerRepository.ts:48,89`. The
frontend requests 1,000 and ignores `meta.hasNext`.

All 21 call sites (regex `limit: ?1000` over `src/`, tests excluded):

| # | Location | Class | Repair |
|---|---|---|---|
| 1 | `src/presentation/hooks/useParties.ts:70-71` | master picker cache | **typeahead** (A) |
| 2 | `src/presentation/hooks/useInventory.ts:81-83` | master picker cache (fabrics, colors, rolls) | **typeahead** (A) |
| 3 | `src/routes/reports.$slug.tsx:80,82,84,86,89` | report aggregation | **server reports** (B) |
| 4 | `src/routes/reports.index.tsx:64` | report aggregation | (B) |
| 5 | `src/routes/ledger.tsx:38` | list | **server pagination** (C) |
| 6 | `src/routes/receipts.index.tsx:31,33`, `payments.index.tsx:31,33` | list + join | (C) |
| 7 | `src/routes/returns.index.tsx:26`, `invoices.tracking.tsx:164` | list + join | (C) |
| 8 | `src/components/cashbox/VoucherTable.tsx:43` | list | (C) |
| 9 | `src/components/vouchers/VoucherForm.tsx:129,134` | per-invoice remaining (tenant-wide returns) | **server remaining** (D) |
| 10 | `src/components/parties/PartyDetails.tsx:261,264,267,276,578,714-715,859-860,864,1635-1642,1801-1808,2059-2061` | per-party tabs | (C) + stats (E) |

**(A) Master pickers — server-side typeahead (final design, not page loops).**
- Endpoints (read-only, admin/accountant/warehouse/viewer as today):
  `GET /api/parties/search?kind=customer|supplier&q=&cursor=&limit≤50&status=active`,
  `GET /api/fabrics/search?q=&cursor=&limit≤50`,
  `GET /api/colors/search?fabricId=&q=&cursor=&limit≤50`,
  `GET /api/rolls/search?colorId=&q=&status=in_stock&cursor=&limit≤50`,
  and `GET /api/{parties,fabrics,colors,rolls}/by-ids?ids=` (≤ 200 ids) for documents that reference old or
  exhausted rows.
- Matching: `ILIKE '%q%'` on name/code/rollNo with escaped metacharacters (REPAIR-006) and the existing
  normalisation (`normalizeInventoryName`, used today in `invoices.sale.new.tsx`) applied server-side. Order:
  exact code match first, then name, then `created_at DESC`.
- **Cursor pagination:** opaque cursor `base64({sortKey, id})` with `WHERE (sortKey, id) > (…)`; no OFFSET.
- Frontend: `PartyCombobox` and the roll/fabric/color pickers call the search with a 250 ms debounce and cancel
  in-flight requests (REPAIR-016 signal); the module caches become **LRU caches of recently used and by-id-fetched
  rows** (≤ 500 entries); the synchronous helpers (`rollById`, `customerById`, `colorById`, `fabricById`) read the
  LRU and trigger a by-id fetch on a miss (returning `undefined` until it arrives, exactly as today on a cold start).
- Stock checks on the sale page (`invoices.sale.new.tsx:333,342`) must use the roll row returned by the picker (it
  carries `remainingKg/remainingPieces`), not the global cache.
- Low-stock and inventory **reports** do not use pickers (see B).

**(B) Reports — server aggregates.** For each report slug a backend endpoint
`GET /api/reports/:slug?from&to&currency&page` returns grouped rows computed in SQL with the **same formulas the
components use today** (copy them 1:1; the per-currency, never-blended rule applies). The inventory report
aggregates by fabric and currency in SQL. Each migrated report gets a parity test: on a fixture of about 50
documents, the old JS function (kept temporarily in the test) and the new endpoint return identical rows.

**(C) Lists** use real server pagination (`page`, `hasNext`) with page controls; label joins use server-joined
fields or by-id fetches.

**(D) VoucherForm** gets per-invoice remaining from the server: add `returnsTotal` and `remaining` to the invoice
list DTO for `partyId` queries (one grouped subquery; cheap after REPAIR-003), and drop the tenant-wide
`useReturnsList`.

**(E) PartyDetails** tabs: paginated lists per tab; KPIs from party stats and the statement endpoint.

Files To Modify: the 21 call sites; `useParties.ts`, `useInventory.ts`, `PartyCombobox.tsx`, the roll/fabric/color
picker components (`src/components/invoices/SaleLineCard.tsx` and siblings — enumerate with
`rg "rollsOfColor|colorsOfFabric|customers\b" src/components`); new backend search, by-ids, and report routes plus
their repository methods (read-only queries).

Files Not To Change: write repositories, ledger posting, sync enqueue/materialize.

Tests:
- Backend: search returns an exact code match first; the cursor walks 1,200 rolls without duplicates or gaps;
  `status=in_stock` excludes exhausted rolls; by-ids returns exhausted rolls.
- Frontend: debounce and LRU unit tests (pure functions).
- Report parity tests per slug; 1,100 invoices → report total equals `SELECT SUM(total)`.
- Regression: 1,200 rolls with 300 in stock (the oldest) → all 300 findable in the sale picker.

Success Criteria: `rg "limit: ?1000" src` returns no call site that treats a single page as "all data"; no picker
loads a full master table.

Performance addendum:
- Current complexity: O(N_masters) transfer and memory at boot, plus O(N) per keystroke; reports
  O(I + V + R + E + G) per render.
- After repair: O(limit ≤ 50) per keystroke (index-assisted after REPAIR-006); reports O(rows in range) in SQL.
- Measured under REPAIR-031 scenarios S-P1..S-P4.

---

## REPAIR-003 — Index returns by original invoice (root cause of correlated-subquery cost)

Status: CONFIRMED (catalog) — the review's contrary claim R-1 is wrong

Category: Database performance

Severity: HIGH

Evidence (`pg_indexes` of the migration-built `erp_test`): `returns` has only `UNIQUE (id)` and
`UNIQUE (tenant_id, kind, number)`; `return_lines` has `UNIQUE (id)` and `UNIQUE (return_id, roll_id)`. There is no
index on `returns.original_invoice_id` (`0001_initial.sql:542` declares only the FK).

All occurrences of "returns of invoice X" (text search; PARTIAL):
1. `PostgresDashboardRepository.ts:380-415` unpaid — correlated subquery **twice** per invoice (SUM and WHERE),
   filtered `r.kind = 'sale'`.
2. `PostgresProfitRepository.ts:397-422` `getDebts` — correlated per invoice, **no** kind filter.
3. `PostgresVoucherRepository.ts` create — per receipt/payment.
4. `settleInvoicesUseCase.ts` — `inArray(returns.originalInvoiceId, ids)`.
5. `PostgresInvoiceRepository.cancel` — `activeReturns`.
6. `customerCredit.ts` `customerCreditPosition` — groups **all** active returns of the tenant on each call (invoice
   create with credit, voucher cancel ×2, invoice cancel ×2, statement per currency).

Technical Repair:
1. Migration `<date>_returns_original_invoice_idx.sql`:
   `CREATE INDEX IF NOT EXISTS idx_returns_tenant_original_invoice ON returns (tenant_id, original_invoice_id, status);`
   (a full index, so both the `kind='sale'` and no-kind predicates can use it; a partial index is an optimisation
   to evaluate later with EXPLAIN). Declare it in `return.table.ts`.
2. Rewrite (1) and (2) to join a grouped subquery once
   (`LEFT JOIN (SELECT r.original_invoice_id, SUM(rl.quantity_kg*rl.price_per_kg) s FROM returns r JOIN return_lines rl … WHERE r.tenant_id=$t AND r.status='active' [AND r.kind='sale'] GROUP BY 1) rr ON rr.original_invoice_id = i.id`),
   **keeping the kind filter exactly as each query has it today** (§19 Q4).
3. `customerCreditPosition`: restrict the returns subquery to invoices of the party (join through
   `invoices.party_id = $party`).

Database-specific: Write cost: one index on a low-write table. Rollback:
`DROP INDEX IF EXISTS idx_returns_tenant_original_invoice`. Validation: on a DB seeded by the REPAIR-031 harness
(≥ 10K invoices, ≥ 1K returns), `EXPLAIN (ANALYZE, BUFFERS)` of queries (1) and (2) shows an index scan on the new
index, or a single hash join, instead of a per-row scan.

Tests: `pg_indexes` contains the index; migration parity; results identical on every existing financial suite
(`customer-statement-reconcile`, `customer-credit-advance`, `voucher-exact-invoice-closure`,
`cross-currency-settlement`, profit/dashboard tests).

---

## REPAIR-005 — `manual_movements`: index and SQL aggregation

Status: CONFIRMED (catalog + code)

Severity: MEDIUM

Evidence: `manual_movements` has only `UNIQUE (id)`. Full loads into Node: `cashboxBalanceHelper.ts:52-53`
(`recomputeCashboxBalanceAsOf`) and `PostgresDashboardRepository.ts:535-549`. The cashbox route's movements
listing (`GET /api/cashbox/manual-movements`) returns every row; check it and paginate it if it is unbounded.

Technical Repair: migration
`CREATE INDEX IF NOT EXISTS idx_manual_movements_tenant_currency_date ON manual_movements (tenant_id, currency, date);`
(declared in `cashbox.table.ts`). Replace both JS loops with
`SUM(CASE WHEN direction='in' THEN amount ELSE 0 END)` / `…'out'…` filtered by `currency = $c AND date BETWEEN $from AND $asOf`
— exactly the JS predicates (`m.currency === currency && m.date >= from && m.date <= asOf`).

Tests: the old-loop vs SQL comparison on a mixed currency/date fixture; `cashbox-daily-balance-contract`,
`cashbox-balance-guard`, and `cashbox-daily-balance-fast-path` stay green.

---

## REPAIR-004b — Dashboard query plan (performance part)

Status: CONFIRMED (static) / NOT MEASURED

Severity: MEDIUM

Evidence: 33 sequential `await this.db` in `getDashboard` (`PostgresDashboardRepository.ts:32-624`); `topFabricRows`
(158-183) aggregates all active sale lines of all time and picks the top N in JS (185-211).

Concurrency rules for any parallelisation (from the verified pool design, §2):
- `this.db` is the pool. **Outside a transaction** each query uses its own client, stamped from AsyncLocalStorage,
  so `Promise.all` is RLS-safe there.
- **Never** use `Promise.all` on a `tx` (one client): pg serialises and warns ("client.query() while already
  executing").
- Limit fan-out: at most **4** concurrent queries per dashboard request (the pool max is 20, `drizzle.ts:86`); use a
  small concurrency helper (`p-limit` style, 20 lines, no dependency) instead of one 33-wide `Promise.all`.
- Prefer merging: the three sales windows (today, week, month) become **one** query with
  `SUM(...) FILTER (WHERE date >= …)`; the roll stats (286-330) become one query.

Technical Repair:
1. Merge queries as above (target: ≤ 12 queries in total, PROPOSED).
2. Run independent groups with concurrency ≤ 4.
3. Top fabrics: push `ORDER BY kg DESC LIMIT N` into SQL. Keep the all-time window unless §19 Q2 decides otherwise.
4. Cash: REPAIR-004a. Unpaid: REPAIR-003.

Tests: before/after equality on a fixture for every KPI field; a **tenant-isolation concurrency test** — two
tenants with distinct data, 20 concurrent dashboard calls interleaved, each response contains only its own
tenant's figures; process-warning spy: no `DeprecationWarning` containing "already executing" during the test
(`process.on('warning')`).

Measurement: REPAIR-031 scenario S-P3 (dashboard p95 before and after).

---

## REPAIR-006 — Search: escape, measure, then index

Status: CONFIRMED (static) / performance NOT MEASURED

Severity: MEDIUM

Evidence: `PostgresInvoiceRepository.ts:91-98` builds `ilike(number, '%term%') OR ilike(reference, '%term%')` without
escaping `%`/`_`; `PostgresRollRepository.ts:43` does the same (enumerate the rest with `rg "ilike\(" backend/src`).
`pg_extension` = `plpgsql, uuid-ossp`. The list order is `date DESC, created_at DESC` (line 114) with only
`(tenant_id, date)` indexed; `COUNT(*)` runs on every list call (116-119).

Technical Repair:
1. **Now:** helper `likeContains(term)` escapes `\`, `%`, `_` and uses `ESCAPE '\'`; apply it to every `ilike` site.
2. **Measure** (REPAIR-031 S-P2: 10K/50K/100K invoices, 20 representative terms).
3. **Default decision for scale (not conditional on hope):** because the product targets multi-year growth, plan to
   add trigram indexes **if S-P2 fails its gate at 50K**:
   `CREATE EXTENSION IF NOT EXISTS pg_trgm;`
   `CREATE INDEX idx_invoices_number_trgm ON invoices USING gin (number gin_trgm_ops);` (and `reference`, the party
   name, and `rolls.roll_no` for the typeahead in REPAIR-001). `pg_trgm` is bundled
   (`desktop/src-tauri/resources/postgres/share/extension/pg_trgm*`, `lib/pg_trgm.dll`) and available on Neon.
   **Privilege check required (§19 Q5):** the role that runs migrations must be allowed to `CREATE EXTENSION`.
4. List order index `(tenant_id, date DESC, created_at DESC)` if S-P1 shows a sort node on deep pages.
5. `COUNT(*)`: keep it (the UI shows totals); consider an estimated count only if S-P1 fails.

Tests: literal `%`/`_` search; ordering unchanged; migration parity for any new index.

---

## REPAIR-016 — Cancel superseded reads (AbortSignal)

Status: CONFIRMED

Severity: LOW-MEDIUM

Evidence: 32 `void signal` in 14 hooks (`useCashbox, useDashboard, useExpenses, useInventory, useInvoices,
useLedger, useNotifications, useOrders, useParties, usePrintJobs, useReturns, useStatement, useSypRateSoftCheck,
useVouchers`). `BaseHttpClient.executeSingle` already supports `config.signal` (`BaseHttpClient.ts:133-150`); the
use-case and repository layers do not accept one.

Technical Repair: add an optional `opts?: { signal?: AbortSignal }` to **read** use cases and repository methods
(list/get/search), passed through `Api*Repository` → `*ApiService` → `client.get(path, { signal })`. Start with
typeahead (REPAIR-001), statement, invoice list, and dashboard. **Never** abort mutations.

Tests: an aborted signal rejects with `AbortError`; React Query marks the query cancelled, not failed.

---

## REPAIR-020 — Drizzle and catalog index drift

Status: CONFIRMED (catalog)

Severity: LOW

Evidence: `invoice.table.ts` declares `idx_invoices_party_date (tenant_id, party_id, date)`; no migration creates it;
it is absent from `pg_indexes`. The catalog has `(tenant_id, party_id, type, status, currency)`, which may cover the
same queries.

Technical Repair: `EXPLAIN` the party-scoped invoice queries on the REPAIR-031 dataset; then either add a
migration creating the index or remove the declaration. REPAIR-025's fingerprint prevents future drift
automatically (the declared-vs-catalog comparison becomes part of CI).

---

# PHASE 4 — Long-term operations

---

## REPAIR-017 — Device outbox retention

Status: CONFIRMED

Severity: LOW now, grows with time

Evidence: no `DELETE` on `sync_outbox` / `sync_inbox` anywhere in `backend/src` (only `TokenDenylist` sweeps
expired tokens).

Technical Repair (device side only): a periodic job on the desktop backend (hourly, `setInterval(...).unref()`,
desktop only) deletes in batches of 1,000:
`DELETE FROM sync_outbox WHERE ctid IN (SELECT ctid FROM sync_outbox WHERE tenant_id=$t AND status='synced' AND synced_at < now() - $N::interval LIMIT 1000)`.
It never touches `pending`, `pushing`, or `rejected` rows. It also deletes the **device-local** mirror in
`sync_inbox` for `applied` rows older than N **only if** they are below the device's pull cursor
(`received_seq <= sync_state.last_pull_seq`); otherwise a re-pull could re-apply them. `N` = **90 days (PROPOSED,
§19 Q10)**. The job excludes these tables from the REPAIR-023 drop check.

Tests: retention keeps every non-synced row and every inbox row above the cursor; deletes only old synced/applied rows.

---

## REPAIR-029 — Hub snapshot, bootstrap, and compaction architecture

Status: CONFIRMED (absence) — design item

Category: Long-term sync scalability

Severity: HIGH over years (unbounded `sync_inbox` growth on the hub)

Evidence: the hub's `sync_inbox` is the data source of `GET /sync/pull` (`listAppliedSince`, `sync.route.ts` pull
handler). A new or reset device pulls from `afterSeq = null` (the whole history). Therefore no hub inbox row can be
deleted today without breaking device bootstrap. `restore-from-backup.mjs` and the pull cursor clamp already
reason about sequence spaces, and those rules must be kept.

Design (to be implemented as its own project, with a short ADR in `docs/decisions.md` first):
1. **Tenant snapshot:** a hub job produces a consistent snapshot of the tenant's business state
   (`pg_dump`-style logical export of the tenant's rows, or a JSON export like `database.json`) inside a
   `REPEATABLE READ` transaction, and records `snapshot_seq = MAX(received_seq)` at that moment. Stored with a
   checksum in hub storage (Neon table or object storage).
2. **Bootstrap path:** a device whose cursor is `null`, or below `min_retained_seq`, downloads the latest snapshot,
   restores it through the verified restore path (REPAIR-028 rules: the tenant is wiped only inside one
   transaction, counts are verified), sets its cursor to `snapshot_seq`, and then pulls normally.
3. **Device registry of progress:** the hub records the last acknowledged `received_seq` per device (a pull
   acknowledgement endpoint; today the hub does not know device cursors).
4. **Compaction rule:** delete hub inbox rows with
   `received_seq < min(snapshot_seq_latest, min(active device ack))` and older than the audit retention, after moving
   them to an **audit archive** (compressed table or file) if legal or audit needs require it.
5. **Long-absent device:** a device whose ack is below `min_retained_seq` must re-bootstrap. Its **pending outbox**
   is pushed **first** (units carry their own op ids and dedupe is by `(tenant_id, op_id)`, which must remain unique
   in the hub for as long as any device can push; keep a compact `op_id` dedupe table if inbox rows are deleted).
6. **Tests required before enabling compaction:** new device after compaction; device offline for (simulated) a
   year returns; device with a pending outbox returns after compaction; concurrent compaction and pull; restore of
   the hub from a snapshot plus the tail.

Decision needed: §19 Q10 (retention windows), Q22 (audit archive requirements). **Until REPAIR-029 is done, the
plan cannot claim bounded hub growth.**

---

## REPAIR-018 — Unused archive tables: decide, do not leave ambiguous

Status: PARTIALLY CONFIRMED

Severity: LOW

Evidence: `ledger_entry_archive` and `yearly_party_summaries` have schemas and migrations but no reader or writer
in `backend/src`; they appear only in the backup list (`backup.route.ts:183-184`).

Decision (§19 Q11), one of:
- **KEEP-RESERVED:** add a comment in both schema files and in `docs/decisions.md` stating they are reserved for
  REPAIR-029's audit archive and must not be written by application code; keep them in backups.
- **REMOVE:** migration `DROP TABLE IF EXISTS ledger_entry_archive, yearly_party_summaries;` (after verifying that
  both are empty in production data via the REPAIR-023 manifest counts), and remove them from the schemas,
  `backup.route.ts`, `restore-from-backup.mjs` (`DELETE_ORDER`/insert order), and `enable-rls.sql`.

Recommended: **KEEP-RESERVED** until REPAIR-029 decides the archive format (this avoids a drop migration followed
by a re-create).

---

## REPAIR-022 — Sweep expired idempotency keys

Status: CONFIRMED

Severity: LOW

Evidence: `idempotency.middleware.ts:162-167` replaces an expired key only on reuse; the `expires_at` index exists;
there is no sweep.

Technical Repair: in the same periodic hook as REPAIR-017 (both desktop and hub):
`DELETE FROM idempotency_keys WHERE ctid IN (SELECT ctid FROM idempotency_keys WHERE expires_at < now() - interval '1 day' LIMIT 5000)`.
If REPAIR-008 Part B is adopted, durable dedupe lives on the business tables, so this sweep does not weaken it.

---

# CROSS-CUTTING RELEASE BLOCKERS

---

## REPAIR-030 — Upgrade-over-real-data test matrix (release blocker)

Status: CONFIRMED (absence)

Category: Release process / desktop upgrade safety

Severity: CRITICAL

Evidence: the 2026-09-22 crash was caused by upgrading over old data (DFP-013 on legacy licences; see the project
memory "upgrade-over-old-data lesson"). The 2026-09-23 incident also involved an existing installation. The
repository's desktop tests (`desktop/scripts/*.test.mjs`, `cargo test`) cover fresh templates and unit logic, but no
automated scenario installs over an existing `%LOCALAPPDATA%\motard-erp`.

Technical Repair:
1. **Fixture corpus** (`desktop/test-fixtures/appdata/`, **not committed if it contains real data**; generated by a
   script from a seeded DB instead): AppData folders from representative versions, e.g. v-prev (current release),
   v-prev-2, a legacy cluster without drizzle history, and a cluster with the DFP-013 legacy licence rows. Each is
   produced by `desktop/scripts/make-appdata-fixture.mjs --version <tag> --seed <profile>` using the REPAIR-031 data
   generator (profiles: 2K and 10K invoices).
2. **Harness** `desktop/scripts/upgrade-matrix.mjs` (Windows runner): for each scenario → copy the fixture into an
   isolated `LOCALAPPDATA` (the rename/restore method already used in the project; see project memory) → silent
   install of the new NSIS build → launch → wait for readiness or a fatal dialog → collect `boot.log`,
   `server.log`, and the manifest → **verify**: expected boot event; table counts and per-table content hashes
   (`md5(string_agg(row::text, '' ORDER BY id))` for business tables) equal to the fixture; tenant id unchanged; sync
   cursor and pending outbox unchanged; a snapshot exists when migrations ran → restart once and verify again →
   uninstall / cleanup.
3. **Scenarios (all mandatory):**

| ID | Scenario | Expected outcome |
|---|---|---|
| S-1 | previous version → current, healthy data | `MIGRATION_OK`, `REUSE`, counts and hashes equal, snapshot created |
| S-2 | previous-2 → current | same as S-1 |
| S-3 | `db-meta.json` missing, `secrets.dat` present | legacy adopt (existing rule), fingerprint verified, counts equal |
| S-4 | drizzle history missing, schema complete | baseline only after the REPAIR-025 diff is empty |
| S-5 | drizzle history missing, schema incomplete | `SCHEMA_UNVERIFIED` refusal, snapshot kept, data untouched |
| S-6 | `pgdata` missing, meta and manifest present | `DATA_MISSING` refusal, no new cluster |
| S-7 | `pgdata` and meta missing, manifest present | `DATA_MISSING` refusal |
| S-8 | failed migration (inject a failing SQL in a test journal) | `MIGRATION_FAILED`, snapshot kept, next boot with the fixed build succeeds |
| S-9 | power loss during migration (kill postgres mid-migration) | next boot: migration re-runs (transactional migrations) or refusal with the snapshot; never partial success |
| S-10 | interrupted installer (kill during file copy) | re-run of the installer repairs the files; data untouched |
| S-11 | `secrets.dat` missing, pgdata present | existing fail-closed rule; data untouched |
| S-12 | device binding mismatch | existing rule (`device_binding.rs`); data untouched |
| S-13 | tenant mismatch (second tenant with data) | `TENANT_MISMATCH`, SAFE_MODE |
| S-14 | intentional factory reset (authorized) | snapshot, `FACTORY_RESET`, `FRESH_TEMPLATE`, new manifest |
| S-15 | uninstall + reinstall (data kept by default) | `REUSE`, counts equal |
| S-16 | update rollback (install the older version over newer data) | existing "newer schema" refusal (`db_meta.rs:166-175`), data untouched |
| S-17 | severe row drop between boots (delete 50% of invoices in the fixture) | `SAFE_MODE` |
| S-18 | restore of a backup with warnings | refused (REPAIR-028) |

4. **Release rule:** an installer may be distributed only with a green matrix run attached to the release notes.

Files To Add: `desktop/scripts/make-appdata-fixture.mjs`, `desktop/scripts/upgrade-matrix.mjs`,
`desktop/scripts/upgrade-matrix.md` (how to run), release checklist entry in `desktop/BUILD-WINDOWS.md`.

Success Criteria: 18/18 green on the release candidate.

---

## REPAIR-031 — Formal performance and resource release gates

Status: CONFIRMED (absence) — the numbers below are PROPOSED and must be agreed (§19 Q14)

Category: Performance / capacity

Severity: HIGH for any claim of "scale" or "withstands load"

Evidence: no load test, benchmark, or data generator exists in the repository (`rg -i "k6|autocannon|benchmark|load test"`
→ none relevant). The only perf-adjacent script that ever existed (`backend/src/scripts/perf-seed.ts`, last seen in commit `bf340593`) has been removed from the repository.

Technical Repair:
1. **Deterministic data generator** `backend/scripts/seed-scale.mjs --invoices 2000|10000|50000|100000 --lines-avg 5 --seed 42`
   writing through the real repositories (or through bulk SQL that mirrors them, validated by the reconciliation
   invariants afterwards: ledger Σdebit = Σcredit, statement = ledger, stock ≥ 0). Profiles: parties = invoices/20,
   rolls = invoices/5, returns = 3%, vouchers = 60%, currencies 70% SYP / 25% USD / 5% EUR.
2. **Scenarios:**
   - S-P1 invoice list (page 0 and page 50), with and without filters
   - S-P2 invoice search (20 terms: prefix, infix, no-hit)
   - S-P3 dashboard
   - S-P4 party statement (largest party)
   - S-P5 invoice create (5 lines)
   - S-P6 receipt create
   - S-P7 typeahead search
   - S-P8 sync drain (backlog of 1K/10K/100K units; measure the drain rate)
   - S-P9 concurrent sales on overlapping rolls (8, 32, and 128 workers)
3. **Runner:** `autocannon` (Node, no new infrastructure) against a disposable DB. The backend is started with the
   same pool settings as production; the report is JSON with p50/p95/p99, req/s, errors, response bytes, DB time
   (`pg_stat_statements` if available), pool wait (instrument `pool.waitingCount`), RSS, CPU, WAL bytes
   (`pg_current_wal_lsn()` diff), table and index sizes, deadlocks (`pg_stat_database.deadlocks`), lock waits.
4. **Gate table — PROPOSED defaults (agree before use; §19 Q14):**

| Operation | 2K | 10K | 50K | 100K |
|---|---|---|---|---|
| invoice list p95 | ≤ 150 ms | ≤ 250 ms | ≤ 400 ms | ≤ 600 ms |
| search p95 | ≤ 200 ms | ≤ 300 ms | ≤ 500 ms | ≤ 800 ms |
| dashboard p95 | ≤ 400 ms | ≤ 700 ms | ≤ 1.2 s | ≤ 2 s |
| statement p95 (largest party) | ≤ 300 ms | ≤ 600 ms | ≤ 1.2 s | ≤ 2 s |
| invoice create p95 | ≤ 250 ms | ≤ 250 ms | ≤ 300 ms | ≤ 300 ms |
| typeahead p95 | ≤ 100 ms | ≤ 120 ms | ≤ 150 ms | ≤ 200 ms |
| sync drain rate | ≥ 1.3 × arrival rate | same | same | same |

   Resource gates (PROPOSED): error rate < 0.1%; deadlocks = 0 in S-P9 after REPAIR-012; pool wait p95 < 50 ms;
   backend RSS < 500 MB; WAL growth per 1K invoices recorded (baseline, no gate until measured twice).
5. **Release rule:** a release claiming a data tier (e.g. "tested to 50K invoices") must attach the gate report for
   that tier. Before REPAIR-001/003/004/006 are merged, run the harness once to record the **baseline** (this is the
   first real measurement in the project's history).

Files To Add: `backend/scripts/seed-scale.mjs`, `backend/scripts/perf-run.mjs`, `backend/perf/scenarios/*.json`,
`backend/perf/README.md`.

Success Criteria: the baseline report exists; every Phase 3 repair attaches a before/after report.

---

## 7. Database / Query Repairs — migration register

All migrations are new files after journal idx 78, declared in the drizzle schemas, and use `IF NOT EXISTS`.

| Order | Migration | Repair | Content | Locking note |
|---|---|---|---|---|
| M1 | `…_sync_outbox_lease.sql` | 027 | 4 nullable columns + backfill | small table on devices; brief lock |
| M2 | `…_returns_original_invoice_idx.sql` | 003 | `(tenant_id, original_invoice_id, status)` | returns is small |
| M3 | `…_manual_movements_idx.sql` | 005 | `(tenant_id, currency, date)` | small |
| M4 | `…_client_operation_id.sql` | 008B | nullable columns + partial unique indexes | **only if Q13 approves** |
| M5 | `…_invoices_list_order_idx.sql` | 006 | `(tenant_id, date DESC, created_at DESC)` | only if S-P1 fails |
| M6 | `…_pg_trgm.sql` | 006 | extension + GIN indexes | only if S-P2 fails; needs privilege (Q5); on the hub consider `CONCURRENTLY` outside the journal |
| M7 | `…_invoices_party_date_idx.sql` or schema removal | 020 | per EXPLAIN | — |
| M8 | `…_drop_archive_tables.sql` | 018 | only if Q11 = REMOVE | — |

Hub (Neon) rule: create a Neon branch before running migrations (manual release step until REPAIR-024 covers the hub).

## 8. Frontend Performance Repairs

REPAIR-001 (typeahead, server reports, pagination, server remaining), REPAIR-002 (party balances), REPAIR-016
(abort). Also watch the 20-second periodic sync added on 2026-09-23 (`useAutoSync`): after REPAIR-001 it must
invalidate only affected query keys, not `qc.invalidateQueries()` for everything, so that a pull does not refetch
every screen (measure under S-P8).

## 9. Backend / API Repairs

REPAIR-004a/b, 008, 009, 010, 011, 012/019, 021, plus the additive integrity endpoints of REPAIR-023 and the
search, by-ids, and report endpoints of REPAIR-001. All API changes are additive except REPAIR-008 A (a required
Idempotency-Key on financial routes), which is a deliberate contract tightening documented in the release notes.

## 10. Synchronization Repairs

REPAIR-007 (atomic claim + run lock), REPAIR-027 (lease token, renewal, dead-letter view), REPAIR-017 (device
retention), REPAIR-029 (hub snapshot/bootstrap/compaction). Guarantee statement to keep in the docs:
**at-least-once delivery with idempotent materialization keyed by `(tenant_id, op_id)`; per-document order
within lanes; global order for lane-0 entity types.**

Sync recovery tests (added by Phase 2): kill during push after the hub accepted but before `markSynced` → the unit
is re-pushed and the hub returns `exists`, with no duplicate; kill during pull after materialization but before
the cursor save → re-pull is idempotent; hub down for 1 hour with a 10K-unit backlog → drains at ≥ the gate rate
after recovery (S-P8).

## 11. Desktop / Runtime Repairs

REPAIR-013, 014, 015, 023, 024, 025, 026 (Phase 0), REPAIR-030 (matrix). Also: stale "SSR" comments in
`desktop/src-tauri/src/runtime/stack.rs` (lines 3, 22, 910, 927) and `device_binding.rs:3` — comment-only cleanup,
done alongside REPAIR-013.

## 12. Security / Reliability Repairs

- Boot log redaction and ACL (REPAIR-013).
- Backups: encryption decision (REPAIR-028, Q19); snapshot files read-only (REPAIR-024).
- SAFE_MODE blocks writes during suspected data loss (REPAIR-023).
- The admin password is required for "accept baseline" and "authorize reset" (REPAIR-023).
- The pre-auth hub pairing routes were already removed on 2026-09-23 (`/sync/hub*` is admin-only); REPAIR-027's
  `/sync/dead` is admin-only as well.
- No new vulnerability was confirmed by this investigation; no penetration testing was performed.

## 13. Dead Code / Duplication Cleanup

REPAIR-018 (archive tables, decision), REPAIR-021 (naming), and the cash formula triplication (dashboard, helper
recompute, cashbox route) resolved by REPAIR-004a/005: all use `getCashboxBalanceAsOf` / one SQL aggregation.
Contract duplication (`src/contracts` vs backend entities) stays a known maintenance cost; REPAIR-011 adds a test
guarding the ledger type list. A full move to shared Zod contracts is **not** planned (no evidence that a smaller
fix is insufficient).

## 14. Required Tests (complete list)

| # | Test | Repair | Kind | Location (new unless noted) |
|---|---|---|---|---|
| T1 | boot_log append / rotate / redact / io-error | 013 | Rust unit | `runtime/boot_log.rs` |
| T2 | server.log rotation; fatal reason still read | 013 | Rust unit | `runtime/stack.rs` tests |
| T3 | evaluateDrop table | 023 | unit | `backend/tests/data-integrity-manifest.test.ts` |
| T4 | SAFE_MODE on severe drop; reads work, writes 503 | 023 | integration | same |
| T5 | manifest + no pgdata → DATA_MISSING; reset authorized → Fresh | 014/023 | Rust unit | `db_meta.rs` tests |
| T6 | snapshot before migrate; failure blocks migrate | 024 | integration | `backend/tests/pre-operation-snapshot.test.ts` |
| T7 | factory reset folder snapshot; low disk refusal | 024 | Rust unit | `runtime/stack.rs` tests |
| T8 | no history → refusal, no rows in `__drizzle_migrations` | 015 | integration | `run-desktop-migrations.test.ts` (update) |
| T9 | fingerprint diff unit cases; live = committed | 025 | unit + integration | `backend/tests/schema-fingerprint.test.ts` |
| T10 | two tenants → TENANT_MISMATCH | 026 | integration | `backend/tests/tenant-consistency.test.ts` |
| T11 | backup with warnings → 500; restore refuses; count mismatch rolls back; drill exit code | 028 | integration | `backend/tests/backup-restore-safety.test.ts` |
| T12 | dashboard currencies not blended | 004a | integration | `backend/tests/dashboard-cash-currency.test.ts` |
| T13 | idempotent settle-invoices; 428 without key | 008 | integration | `backend/tests/financial-idempotency.test.ts` |
| T14 | 2-dp rejections; historical replay normalised; invariant property | 009 | unit + integration | `packages/shared` + backend |
| T15 | party inactive persists / filters / syncs | 010 | integration | `backend/tests/party-status-inactive.test.ts` |
| T16 | ledger type union equals backend list | 011 | unit | `src/domain/types/ledgerTypes.test.ts` |
| T17 | concurrent claimBatch disjoint; run lock | 007 | integration | `backend/tests/sync-claim-atomic.test.ts` |
| T18 | stale lease cannot finalize; lost lease skips rollback; renewal | 027 | integration | `backend/tests/sync-lease-token.test.ts` |
| T19 | opposite-order locking × 50 without 40P01; messages preserved | 012 | integration | `backend/tests/roll-lock-order.test.ts` |
| T20 | party balances = statement matrix | 002 | integration | `backend/tests/party-balances-equivalence.test.ts` |
| T21 | typeahead cursor / status / by-ids; picker finds old in-stock rolls | 001 | integration | `backend/tests/master-typeahead.test.ts` |
| T22 | report parity per slug | 001 | integration | `backend/tests/report-parity.test.ts` |
| T23 | `pg_indexes` contains new indexes; financial suites unchanged | 003/005 | integration | `backend/tests/index-presence.test.ts` |
| T24 | manual movement SQL = old loop | 005 | integration | same file as T23 or cashbox tests |
| T25 | dashboard equality + tenant isolation under concurrency + no pg warning | 004b | integration | `backend/tests/dashboard-concurrency.test.ts` |
| T26 | LIKE escape | 006 | integration | `backend/tests/search-escape.test.ts` |
| T27 | abort read cancels | 016 | unit | `src/infrastructure/http/BaseHttpClient.test.ts` |
| T28 | device retention boundaries | 017 | integration | `backend/tests/sync-retention.test.ts` |
| T29 | idempotency sweep | 022 | integration | same as T28 |
| T30 | upgrade matrix S-1..S-18 | 030 | Windows E2E | `desktop/scripts/upgrade-matrix.mjs` |
| T31 | perf scenarios S-P1..S-P9 | 031 | benchmark | `backend/scripts/perf-run.mjs` |
| T32 | sync recovery (kill during push/pull; hub outage drain) | 007/027 | integration | `backend/tests/sync-recovery.test.ts` |

Existing suites that must stay green throughout: all of `backend/tests` (482 tests at the time of writing, with the
dev DB up), the root `vitest` (215), and `cargo test`.

## 15. Verification Matrix

| Repair ID | Problem Proven? | Root Cause Proven? | All Occurrences Checked? | Files Identified? | Business Rule Protected? | Tests Defined? | Verification Defined? |
|---|---|---|---|---|---|---|---|
| REPAIR-013 | YES | YES | YES | YES | YES | YES | YES |
| REPAIR-014 | YES | YES | YES | YES | YES | YES | YES |
| REPAIR-023 | YES (absence) | YES | YES | YES | YES (safety rule only) | YES | YES |
| REPAIR-024 | YES (absence; pg_dump not bundled) | YES | YES | YES | YES | YES | YES |
| REPAIR-015 | YES | YES | YES | YES | YES | YES | YES |
| REPAIR-025 | YES (absence) | YES | YES | YES | YES | YES | YES |
| REPAIR-026 | PARTIAL (defect not proven; absence proven) | PARTIAL | YES | YES | YES | YES | YES |
| REPAIR-028 | YES | YES | YES | YES | YES | YES | YES |
| REPAIR-004a | YES | YES | YES | YES | PARTIAL (Q3) | YES | YES |
| REPAIR-008 | YES | YES | YES (financial POST routes) | YES | YES | YES | YES |
| REPAIR-009 | YES (worked example) | YES | PARTIAL (other schemas to re-check) | YES | PARTIAL (Q6) | YES | YES |
| REPAIR-010 | YES | YES | YES | YES | PARTIAL (Q7) | YES | YES |
| REPAIR-011 | YES | YES | PARTIAL (list derived by search) | YES | YES | YES | YES |
| REPAIR-021 | YES | YES | YES | YES | YES | YES (tsc) | YES |
| REPAIR-007 | YES | YES | YES | YES | YES | YES | YES |
| REPAIR-027 | YES | YES | YES | YES | YES | YES | YES |
| REPAIR-012/019 | YES (mechanism) | YES | PARTIAL (lock loops by search) | YES | YES | YES | YES |
| REPAIR-002 | YES | YES | YES | YES | YES | YES (matrix) | YES |
| REPAIR-001 | YES | YES | YES (21 sites, regex) | YES | YES | YES | YES |
| REPAIR-003 | YES (catalog) | YES | PARTIAL (6 sites by text search) | YES | YES | YES | YES |
| REPAIR-005 | YES (catalog) | YES | PARTIAL (cashbox listing to re-check) | YES | YES | YES | YES |
| REPAIR-004b | YES (static) | YES | YES | YES | PARTIAL (Q2) | YES | NOT PROVEN until S-P3 |
| REPAIR-006 | YES (static) | YES | PARTIAL (`ilike` sites to enumerate) | PARTIAL | YES | YES | NOT PROVEN until S-P2 |
| REPAIR-016 | YES | YES | YES (32) | YES | YES | YES | YES |
| REPAIR-020 | YES (catalog) | PARTIAL | PARTIAL (invoices only; 025 generalises) | YES | YES | YES | PARTIAL |
| REPAIR-017 | YES | YES | YES | YES | PARTIAL (Q10) | YES | YES |
| REPAIR-029 | YES (absence) | YES | YES | PARTIAL (design) | PARTIAL (Q10, Q22) | YES (listed) | PARTIAL |
| REPAIR-018 | YES | YES | YES | YES | NOT PROVEN (intent) | NO (decision first) | NO |
| REPAIR-022 | YES | YES | YES | YES | YES | YES | YES |
| REPAIR-030 | YES (absence) | YES | YES | YES | YES | YES | YES |
| REPAIR-031 | YES (absence) | YES | YES | YES | YES | YES | PARTIAL (thresholds need Q14) |

## 16. Implementation Order and Release Gates

**Phase 0 — protect customer data (ship before any other installer)**
1. REPAIR-013 durable boot-decision log.
2. REPAIR-024 step 0 (bundle `pg_dump`/`pg_restore`), then pre-operation snapshots.
3. REPAIR-023 data-integrity manifest and SAFE_MODE.
4. REPAIR-014 fail closed on missing data.
5. REPAIR-015 stop the blind baseline (interim), then REPAIR-025 full fingerprint.
6. REPAIR-026 tenant consistency.
7. REPAIR-028 backup and restore correctness, automatic backup, drill.
**Gate G0:** T1–T11 green; REPAIR-030 scenarios S-1, S-3, S-5, S-6, S-7, S-8, S-14, S-16, S-17, S-18 green on the
release candidate.

**Phase 1 — correctness**
8. REPAIR-004a, 010, 008 (Part A), 011, 021; REPAIR-009 after its audit script has run on real data and Q6 is answered.
**Gate G1:** T12–T16 green; full suites green.

**Phase 2 — concurrency and sync**
9. REPAIR-007 + REPAIR-027 (one change set: migration M1, claim, token-guarded finals, renewal, run lock, dead view).
10. REPAIR-012/019.
**Gate G2:** T17–T19, T32 green; S-P9 shows 0 deadlocks.

**Phase 3 — completeness and performance**
11. REPAIR-031 harness and **baseline measurement** (must precede 12–15).
12. REPAIR-002, then REPAIR-001 (typeahead → reports → lists → VoucherForm → PartyDetails).
13. REPAIR-003, REPAIR-005 (migrations M2, M3), then REPAIR-004b.
14. REPAIR-006 (escape now; indexes per S-P1/S-P2), REPAIR-016, REPAIR-020.
**Gate G3:** T20–T27 green; S-P1..S-P7 meet the agreed gates (Q14) at the claimed tier.

**Phase 4 — long-term operations**
15. REPAIR-017, REPAIR-022, backup scheduling and retention (028 B), restore drill cadence.
16. REPAIR-029 design ADR, then implementation; REPAIR-018 decision.
17. Observability: publish p95/p99 per endpoint from the logs (a pino `responseTime` aggregation job), plus
    backlog size, dead units, last backup age, and manifest status on an admin "system health" page (all existing
    data; no new infrastructure).
**Gate G4:** T28–T29 green; REPAIR-029 tests green before any hub compaction is enabled.

**Every installer after Phase 0:** full REPAIR-030 matrix (S-1..S-18) green and attached to the release notes.

## 17. Protected Business Rules

- Double-entry legs, debit/credit meaning, and the ledger as the single source of truth for balances.
- Per-currency reporting; never blend currencies (REPAIR-004a restores this rule; it does not change it).
- FX: frozen document rates; settlement uses the payment-time entered rate (`convertForSettlement`,
  `settleAmountAgainstRemaining`). Only the `round2dp` implementation is touched, and only if Q6 approves.
- COGS at sale time from the cost snapshot; profit = revenue − COGS − expenses; receivables and payables are never
  subtracted.
- Negative cash balances are **allowed with a warning**.
- Customer overpayment → customer credit; credit applied at invoice creation; cancel refused when spent credit
  would vanish (2026-09-23 behaviour, `customerCredit.ts`). REPAIR-003 changes only its query cost.
- Remaining = total − paid − active returns. The dashboard counts `kind='sale'` returns while profit debts count
  all active returns; both are preserved (Q4).
- Stock: `rolls.remaining_kg/pieces` invariants, first-write-wins claims, and entry-cancel fails closed if stock
  was consumed.
- Sync: at-least-once + idempotent apply; lane ordering; lease reclaim; conflicts never silently overwritten.
- Desktop: an existing `pgdata` is never overwritten; mismatches fail closed; factory reset keeps
  secrets and device binding.

**Data invariants every change must keep:** ledger Σdebit = Σcredit per reference; statement final balance = ledger
balance; invoice `paid ≤ total` (with credit and overpay rules); stock ≥ 0 unless the existing rules allow otherwise;
sequence numbering gapless per the existing tests; `(tenant_id, op_id)` unique.

**API contracts to preserve:** all existing response shapes (only additive fields); `{skipped, reason}` for
concurrent sync runs; error codes used by the UI (`SYNC_CONFLICT`, device-trust codes, `SETUP_REQUIRED`,
`DAY_LOCKED`, etc.). The only intended tightening is REPAIR-008 A.

## 18. Files Explicitly Out of Scope

- Existing migration SQL files (only new ones may be added).
- `backend/src/infrastructure/orm/rls/enable-rls.sql` (except REPAIR-018 REMOVE).
- Ledger posting paths in `PostgresInvoiceRepository.create/update/cancel`,
  `PostgresVoucherRepository.create/cancel`, and `PostgresReturnRepository`, except the lock-ordering refactor of
  REPAIR-012/019, which must not change any check or message.
- `packages/shared/src/fx.ts`, `settlementAllocation.ts`, `settlementAmounts.ts`.
- Hub ingestion and materialization (`receiveSyncPush`, `syncMaterialize.ts`), except the optional precision
  normaliser of REPAIR-009 step 4; claims; conflicts.
- `desktop/src-tauri/src/secret_store.rs`, `device_binding.rs`, `fingerprint.rs`, `identity.rs`.
- Print templates (`src/components/print/*`) and the light/dark theme work.
- `divin-plean.md`, `SKILL.md`, `impove-the-PEPAIR-PLAN.md` (inputs; untracked — decide whether to commit them).

## 19. Open Questions Requiring Human Decision

| Q | Repair | Question | Recommendation |
|---|---|---|---|
| Q2 | 004b | BUSINESS RULE UNCERTAIN: should "top fabrics" stay all-time or use a window? | keep all-time until decided |
| Q3 | 004a | Without a cash session, should the scalar `cashBalance` be the SYP figure, `null`, or removed in favour of the map? | `null` + map |
| Q4 | 003 | BUSINESS RULE UNCERTAIN: dashboard unpaid counts only `kind='sale'` returns; profit debts count all. Intentional? | keep both until decided |
| Q5 | 006 | May the migration roles (desktop, Neon) `CREATE EXTENSION pg_trgm`? Is a brief index-build lock acceptable on the hub? | verify on staging |
| Q6 | 009 | Official rounding convention (half-up with EPSILON?) and handling of historical >2-dp payloads | half-up + EPSILON; normalise on replay |
| Q7 | 010 | BUSINESS RULE UNCERTAIN: may an inactive (موقوف) party be selected in new documents? | not selectable in new documents; still visible in history |
| Q8 | 014 | Offer "start empty anyway" or only a confirmed factory reset? | only a confirmed factory reset |
| Q10 | 017/029 | Retention N for device synced outbox; hub retention windows | 90 days device; hub after 029 |
| Q11 | 018 | Keep-reserved or remove the archive tables | keep-reserved |
| Q13 | 008 | Adopt durable `client_operation_id` (Part B)? | yes, after Part A is stable |
| Q14 | 031 | Agree the numeric gates (table in REPAIR-031) and the target data tier | agree before Phase 3 |
| Q15 | 013 | Boot log size and retention | 1 MiB × 5 |
| Q16 | 023 | Severe-drop threshold | max(20 rows, 10%) on invoices/parties/rolls/ledger |
| Q17 | 023 | Which tables participate in the drop check | invoices, parties, rolls, ledger_entries, vouchers |
| Q18 | 024 | Snapshot retention | last 5 + 30 days |
| Q19 | 028 | Backup schedule, retention, encryption, off-device target, RPO/RTO | daily; 7/4/12; encrypt; user-chosen second folder; RPO 24 h |
| Q20 | 025 | Strict or report-only fingerprint on the hub | report-only on the hub, strict on desktop |
| Q21 | 027 | Dead-letter workflow for financial units | manual resolution only |
| Q22 | 029 | Audit or legal retention for sync history | needs an owner |
| Q-inc | incident | Is there any copy of `%LOCALAPPDATA%\motard-erp\pgdata` from before 2026-09-23 09:58 (external disk, other user profile, installer backup)? | check before any further action on that machine |

(Q1 and Q9 from v1 are resolved by the redesign: Q1 → typeahead replaces page ceilings; Q9 → REPAIR-025 plus the
support CLI replaces the sentinel list.)

## 20. Final Repair Summary and Honest Readiness Assessment

**What the plan fixes (verified root causes):** silent 1,000-row truncation; a wrong party-balances report;
currency blending on the dashboard; missing indexes behind the correlated-subquery cost; non-atomic sync claims
and stale-worker overwrites; unordered roll locks; the party "inactive" contract bug; financial idempotency gaps;
precision drift; the blind migration baseline; missing pgdata going unnoticed; unrecorded boot decisions;
backups reported successful with warnings; and restores that can wipe tables.

**What the plan adds that did not exist:** a data-safety state machine with a persistent manifest, SAFE_MODE,
pre-operation snapshots, a full schema fingerprint, tenant consistency checks, automatic and verified backups
with restore drills, an upgrade-over-real-data matrix, and the project's first performance harness and gates.

**What remains unproven after implementation, until measured or built:**

| Claim | Status after Phases 0–3 | What proves it |
|---|---|---|
| Customer data loss is detected and blocked | Proven by T3–T11 and matrix S-1..S-18 | green G0 |
| Correct numbers at any data size | Proven for the fixed paths by T12–T22 | green G1/G3 |
| "Withstands load" at tier X | **Not proven** until REPAIR-031 passes at tier X with agreed gates | gate report |
| Bounded growth over years | **Not proven** until REPAIR-029 is implemented and tested | 029 tests + compaction in production |
| Disaster recovery | Partially: local backups + drill; off-device depends on Q19 | monthly drill reports |
| The cause of the 2026-09-23 incident | **Not provable** retroactively; future incidents will be recorded (REPAIR-013) | — |

**Engineering verdict:** after Phases 0–3 with green gates, the system can be described as *ready for a controlled
pilot release at the measured data tier*. It must **not** be described as "100/100", "guaranteed for ten years", or
"withstands any load"; those claims require REPAIR-029, REPAIR-031 at the claimed tier, and a sustained
operational record (backup drills and upgrade matrices across several releases).
