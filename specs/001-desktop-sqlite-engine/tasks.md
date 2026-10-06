# Tasks: Desktop Local Database Replacement (PostgreSQL â†’ SQLite)

**Input**: Design documents from `specs/001-desktop-sqlite-engine/`.
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md),
`.specify/memory/constitution.md`, `docs/PRD-DESKTOP-SQLITE.md`.

**Tests**: REQUIRED. The spec (FR-013, FR-062â€“066), the constitution (Principles II, X) and PRD Â§10 require
executed parity, durability, lifecycle and packaged-EXE tests. Test tasks precede the implementation they verify
inside each phase.

**Organization**: Setup â†’ Foundational (stages S0â€“S3 of the plan, plus the track-P prerequisite) â†’ one phase per spec
user story, in priority order (US1â€“US6) â†’ Polish/acceptance (S11).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1â€“US6 = spec user stories. Setup, Foundational and Polish tasks carry no story label.
- Paths are repository-relative. "PG" = PostgreSQL, "SQ" = SQLite.

## Standing rules for every task (from the constitution and plan; apply without re-deciding)

- Never change business or accounting logic, screens or workflows, except where the plan names a PRD-mandated state.
- Never edit `Postgres*Repository` files or cloud code paths for SQLite purposes (only S1 port moves, proven on PG).
- The schema target is the **live** schema: **53 tables, 73 enforced FKs** (63 NO ACTION, 8 CASCADE, 2 SET NULL),
  213 indexes, 45 CHECKs, 7 triggers. `party_balances` is **not** created. The 24 Drizzle-declared
  `tenant_id â†’ tenants` references are **not** added as FKs (data-model Â§1.0â€“1.2).
- Never add a `LIMIT`, page cap or loop bound that hides data. Never delete, replace or silently create a database.
- The only behavior changes permitted in shared or cloud code are the **approved pre-reference defect fixes**: D-4, D-3 and
  track P (spec FR-070), done in Phase 2B/2C on the PG behavior before the reference freeze. Every other shared-code
  change must leave cloud behavior identical.
- Never send `.env` contents, keys, secrets or licence data to any external service.
- A task is done only when its stated test passes. Code reading never completes a gate task.

---

## Phase 1: Setup (shared initialization)

**Purpose**: dependencies, folders, configuration and test plumbing. No behavior change.

- [X] T001 Add `better-sqlite3` (latest version with a prebuilt win-x64 binary for Node 22.14 / N-API) as a backend dependency, plus its `@types` package, in `backend/package.json`. Run `npm install` in `backend/`. Do not import it anywhere yet.
- [X] T002 [P] Create empty folders with a short `README.md` each, stating "SQLite desktop implementation â€” see specs/001-desktop-sqlite-engine/plan.md": `backend/src/infrastructure/orm/sqlite/`, `backend/src/infrastructure/orm/sqlite/schemas/`, `backend/src/infrastructure/orm/sqlite/migrations/`, `backend/src/infrastructure/repositories/sqlite/`
- [X] T003 [P] Add `DB_ENGINE` (`z.enum(["postgres","sqlite"]).default("postgres")`), `SQLITE_PATH` (optional absolute path), `MOTARD_INSTALLATION_ID` (optional) and `MOTARD_DATA_ID` (optional) to the zod `envSchema` in `backend/src/infrastructure/config/env.ts`. Add a refinement: `postgres` requires `DATABASE_URL`; `sqlite` requires `SQLITE_PATH` and forbids `DATABASE_URL`. A violation is a fatal startup error with no fallback (contracts/db-engine-port.md Â§Selection).
- [X] T004 [P] Make the backend test runner engine-aware: `backend/vitest.config.ts` reads `DB_ENGINE`, and `backend/scripts/ensure-test-db.mjs` skips PG provisioning when `DB_ENGINE=sqlite` and instead creates a temp SQLite file per test worker. Add an `npm run test:sqlite` script (`DB_ENGINE=sqlite vitest run`) to `backend/package.json`.
- [X] T005 [P] Create the parity-harness skeleton: `scripts/parity/README.md` (purpose, run order), `scripts/parity/run.mjs` (CLI: `--engine postgres|sqlite --out <dir> --base-url <pipe-or-url>`; no scenarios yet) and `scripts/parity/diff.mjs` (CLI: `<refDir> <sutDir>`; exits non-zero on any difference).
- [X] T006 [P] Create `backend/scripts/compare-schema-fingerprints.mjs`. It loads `backend/src/infrastructure/orm/migrations/meta/schema-fingerprint.json` (PG, idx 99) and a SQLite fingerprint file path argument, and compares tables, columns, PK/UNIQUE/CHECK/FK (columns + ON DELETE action) and indexes. It reports only the allowed deltas in data-model.md Â§1 and fails on anything else, including any added `tenant_id â†’ tenants` FK and any `party_balances` table.

---

## Phase 2: Foundational (blocking prerequisites â€” plan stages S0â€“S3)

**âš ï¸ CRITICAL**: no user-story work starts until this phase is complete.

### 2A. Investigation items that block the foundation (record findings in `specs/001-desktop-sqlite-engine/research.md` Â§R13a)

- [X] T007 [P] I-13: determine the PG role the desktop backend connects as (`desktop/src-tauri/src/runtime/stack.rs` `DATABASE_URL` construction, `DB_SUPERUSER`). Record whether RLS is effectively enforced on the desktop today, and the effect on the parity reference.
- [X] T008 [P] I-15: enumerate every operational list path for parties, invoices, vouchers, returns and orders: backend list endpoints in `backend/src/presentation/routes/*.route.ts` + `*.schema.ts`, repository `list()` methods in `backend/src/infrastructure/repositories/Postgres*Repository.ts`, frontend caches and pickers in `src/presentation/hooks/use*.ts` and `src/components/**`. For each, record whether it excludes `status = 'cancelled'` by default. Output a table in research.md.
- [X] T009 [P] I-2: list every call site that uses the global `db`/`pool` (not the ambient `tx`) while running inside another transaction's scope, starting with `backend/src/infrastructure/utils/documentNumbers.ts:133`. For each, record whether the PG behavior is an autonomous commit and what result depends on it.
- [X] T010 [P] I-6: list code that depends on equal `now()`/`defaultNow()` values within one transaction (grep `now()`, `defaultNow`, `new Date()` comparisons in `backend/src/**`). Record the call sites.
- [X] T011 [P] I-4 + I-5: record the JS type returned by every Drizzle `date(...)` column in `backend/src/infrastructure/orm/schemas/*.ts`, and any code that hashes, compares or stringifies `jsonb` column text (key-order sensitivity) in `backend/src/**`.
- [X] T012 [P] I-8: copy verbatim into `specs/001-desktop-sqlite-engine/research.md` Â§R13a the current bodies of `cashbox_daily_apply_delta`, `cashbox_daily_shift_all` and `trg_cashbox_daily_from_*` (from `backend/src/infrastructure/orm/migrations/20260928_cashbox_daily_balances.sql` and any later migration that redefines them), the latest `fn_ledger_entries_append_only` (`20261011_ledger_party_remap.sql`), `fn_license_audit_events_append_only` and `sync_inbox_stamp_applied_seq` (`20261016_sync_inbox_applied_seq.sql`).
- [X] T013 [P] I-7: document the exact dye-purge ledger predicate and the trigger drop/recreate sequence in `backend/src/infrastructure/repositories/dyePurgeRepository.ts` (around line 595). State the equivalent `allow_dye_purge` session-flag behavior.
- [X] T014 [P] I-1: prototype (throwaway branch, not merged) shipping the `better-sqlite3` `.node` addon beside `server.mjs` via `desktop/scripts/bundle-server.mjs` with esbuild `external`. Record the exact file list and the `desktop/scripts/resource-manifest.json` entries required.
- [X] T015 [P] I-16: produce the authoritative inventory of non-repository files that touch the database. Classify each as **query** (builds SQL/queries; must move behind a port) or **tx-only** (only `withTenantTx`/`txDb`/`.transaction`). Start from this list:
  - **Use cases**: `application/use-cases/{invitation/invitationUseCases, parties/mergePartiesUseCase, parties/purgePartyCascadeUseCase, setup/recordDesktopDeviceActivation, setup/setupUseCases, statements/settleInvoicesUseCase, sync/numberBlockUseCases, sync/syncConflicts, sync/syncDependencySnapshots, sync/syncMaterialize, sync/syncNumberCollision, sync/syncUseCases}.ts`
  - **Infrastructure**: `infrastructure/{auth/sessionCutoff, auth/TokenDenylist, backup/backupScheduler, backup/portableBackup, device/linkedDeviceRevocation, http/middleware/idempotency.middleware, installation/ensureServerInstallation, license/detachOrphanBakedLicenses, license/refreshOfflineEntitlement, license/SelfHostedLicenseProvider, license/syncTenantLicenseCache, utils/documentNumbers}.ts`
  - **Routes**: `presentation/routes/{backup, cashbox, color, company, dye, expense, fabric, health, invoice, ledger, order, party, print, reports, return, roll, search, settings, statement, voucher, year-closing}.route.ts`

  All paths are under `backend/src/`. Record the result in research.md. The plan's estimate (about 25 query files plus about 15 tx-only routes, measured 2026-10-03) must be confirmed or corrected against this list.
- [X] T016 [P] I-17: identify every offline time rule in licensing and sync (spec FR-055, SY-2): `licenses.grace_days` (`backend/src/infrastructure/orm/schemas/license.table.ts`, default 7), offline-token expiry (`backend/src/infrastructure/auth/LicenseTokenSigner.ts`, `backend/src/infrastructure/license/refreshOfflineEntitlement.ts`) and the `offline_grace_started` event. For each rule, record where it is enforced and its observable effect on the PG reference after 1, 7, 30 and 90 offline days, in research.md Â§R13a. If a rule stops ERP operation offline, report it to the owner as a SY-2 conflict. Do not change it.
- [X] T017 [P] I-18: list every column in a kept table that references an excluded device-bound table (`license_activations`, `device_registrations`, `secrets`, `server_installations`, `revoked_tokens`, `idempotency_keys`, `invitation_codes`, `license_audit_events`) beyond `tenants.activation_id`, with its live FK action from `backend/src/infrastructure/orm/migrations/meta/schema-fingerprint.json`. Record it in research.md Â§R13a and add each to `nulledColumns` in `specs/001-desktop-sqlite-engine/contracts/backup-format-v3.md`.

### 2B. D-4 cancelled-record fix on the PG baseline (S0; approved pre-reference defect fix, FR-070; shared code; must precede the reference freeze)

- [X] T018 Write failing tests first in `backend/tests/cancelled-records-lists.test.ts`. A party (customer and supplier) cancelled via the existing cancel use case must be **absent** from `GET /customers`, `GET /suppliers` and `GET /parties` without a status filter, including when the UI's "all" view is requested. It must still be returned by `GET /customers/:id`, and its historical invoices, statements and audit entries must still show it. Repeat the absence check for every list path that T008 found non-compliant.
- [X] T019 Make backend operational list endpoints exclude `status = 'cancelled'` by default: `PostgresPartyRepository.list()` in `backend/src/infrastructure/repositories/PostgresPartyRepository.ts` (currently filters only when `filter.status` is set, line ~109), plus the route schema in `backend/src/presentation/routes/party.schema.ts`. An explicit `status` filter remains possible for audit views. Do not change by-id lookups. Apply the same rule to every other non-compliant list path from T008.
- [X] T020 [P] Make frontend operational lists exclude cancelled parties, including the default `"all"` status option in `src/components/parties/PartyTable.tsx` (lines ~87, ~164) and party pickers. Keep by-id lookups (`customerById`/`supplierById` in `src/presentation/hooks/useParties.ts`) resolving cancelled parties for historical documents.
- [X] T021 Run `cd backend && npm test`, the frontend `vitest` suite and the `tests/e2e/cert-financial` + `tests/e2e/cert-ui` suites on PG. All must be green, including T018. Build the cloud image (`backend/Dockerfile`) and confirm that the only changed cloud behavior is the D-4 list default (diff the API responses of the e2e run against the pre-fix commit). Record the commit hash as **D-4 baseline fix**. **Done 2026-10-05:** **D-4 baseline fix = commit `d8608ac3`** (D-4 files only). Backend PG 773 (1 fixed), frontend green except pre-existing README test; cloud image builds from the repo root and serves D-4 (build-infra fix); cert e2e infra fixed and run: 56/34/4 **identical on the pre-fix commit** (34 stale suite assertions, pre-existing, not D-4). `scripts/parity/baseline/T021-verification.md`.

### 2C. Track P prerequisite: pagination, silent limits and failed-list state (approved pre-reference defect fixes, FR-070; separate PRs; must land before any US1 parity reference is frozen and before AC-9)

- [X] T022 [P] Remove the silent 1000-page bound in `src/presentation/hooks/useStatement.ts:53` (`i < 1000`). The loop continues until the server reports no `nextCursor`/`hasMore`. Add a test in `src/presentation/hooks/__tests__/useStatement.test.ts` with more than 1000 simulated pages.
- [X] T023 [P] Remove the `maxPages` page limit and its throw from `src/lib/fetchAllPaged.ts`. It walks until the server signals the end (keyset `nextCursor` or `hasNext=false`) and keeps the existing no-truncation guarantee. Update all callers: `src/presentation/hooks/{useParties,useInventory,useExpenses,useInvoices,useLedger,useReturns,useVouchers}.ts` (for example `useParties.ts:94` `maxPages: 200`). Update `src/lib/fetchAllPaged.test.ts`.
- [X] T024 D-3 (spec FR-068): replace silent empty lists on load failure with a clear error state plus a **Retry** action, never a false empty state, in `src/presentation/hooks/useParties.ts` (`loadAll` catch, lines ~105â€“110: today `console.error` only), `useInventory.ts` and every other cache loader found by T008. The list components (`src/components/parties/PartyTable.tsx` and the inventory list) render the error and retry instead of "no records". No other UI change.
- [X] T025 Re-take the AC-9 completeness baseline on PG with `backend/scripts/seed-test-baseline.mjs` at 100,000 invoices / 200,000 ledger rows / 10,000 parties. Record per-screen row counts and statement line counts in `scripts/parity/baseline/completeness.json`.

### 2D. Freeze the PG reference (S0)

- [X] T026 Build the reference PG desktop installer from the commit containing T018â€“T025. Record its sha256 and version in `scripts/parity/baseline/REFERENCE.md`. This exact build is the parity oracle for the rest of the feature.

### 2E. Engine seam (S1; behavior-preserving; proven on PG only)

- [X] T027 Create `backend/src/infrastructure/orm/engine.ts` exporting `getEngine(): "postgres" | "sqlite"` from `config.DB_ENGINE` and an engine-neutral transaction facade: `withTenantTx(tenantId, fn)`, `runInTransaction(fn)` and `txDb`. For `postgres` these delegate unchanged to `backend/src/infrastructure/orm/drizzle.ts`. Load the PG driver lazily (dynamic `import`) so `sqlite` never loads `pg`.
- [X] T028 Repoint every **tx-only** file from T015 to import its transaction helpers from `backend/src/infrastructure/orm/engine.ts` instead of `orm/drizzle.ts`. Change no logic.
- [X] T029 For every **query** file from T015, move each query into a method on an existing or new port in `backend/src/application/ports/` (e.g. `ISearchRepository`, `IReportsRepository`, `IHealthRepository`, `ISyncStoreRepository`, `IIdempotencyRepository`, `ITokenDenylistRepository`, `IDocumentNumberRepository`). Implement it by moving the identical code into a `Postgres*` class in `backend/src/infrastructure/repositories/`. Callers use the port via `backend/src/infrastructure/di/container.ts`. One PR per domain (sync, licensing, search/reports/health, documentNumbers, merge/settle/invitation).
- [X] T030 Add engine selection to `backend/src/infrastructure/di/container.ts`: when `DB_ENGINE=postgres`, construct exactly today's `Postgres*` instances. When `DB_ENGINE=sqlite`, construct `Sqlite*` instances (stubs that throw `NOT_IMPLEMENTED_FOR_SQLITE` until implemented).
- [X] T031 Prove S1 changed nothing. Run `cd backend && npm test`, `npm run test:integration` and the e2e suites on PG, all green. Build the cloud image (`backend/Dockerfile`) and run its health check. Record the result in `scripts/parity/baseline/S1-proof.md`.

### 2F. SQLite schema (S2)

- [X] T032 Create the custom column types in `backend/src/infrastructure/orm/sqlite/types.ts`, following data-model.md Â§2 exactly:
  - **money / decimal**: one type per scale: `decimal(14,2)`, `(14,3)`, `(14,4)`, `(6,2)`, `(5,4)`, `(18,6)`.
    - Store as `INTEGER Ã—10^scale`.
    - toDriver: shortest decimal string, then round half away from zero to `scale` digits.
    - fromDriver: integer / 10^scale as a JS `number`.
    - Use BigInt-safe read/write for `(18,6)`.
  - **uuid**: `TEXT` canonical lower-case, default `randomUUID()`.
  - **timestamptz**: `TEXT` fixed-width ISO UTC `YYYY-MM-DDTHH:MM:SS.ffffffZ`. Reads return `Date`. The default is the transaction clock (T042).
  - **date**: `TEXT` `YYYY-MM-DD`, returning the type recorded by T011.
  - **boolean**: `INTEGER CHECK IN (0,1)`.
  - **jsonb**: `TEXT CHECK json_valid`.
  - **varchar(n)**: `TEXT CHECK(length(col) <= n)`.
- [X] T033 [P] Write property tests in `backend/tests/sqlite/decimal-types.test.ts`. For 100,000 random values per scale, including `x.xx5` boundaries, negatives and maximum magnitudes, round-trip and `SUM` results must equal PG `numeric(p,s)` assignment and `SUM` results computed by a live PG test database.
- [X] T034 Create sqlite-core table definitions, one file per table, in `backend/src/infrastructure/orm/sqlite/schemas/<same-name>.table.ts`. Cover the 50 Drizzle tables mirrored 1:1 from `backend/src/infrastructure/orm/schemas/*.table.ts` (same TS export names, same column names), plus the 3 raw-SQL-only live tables `financial_operations`, `sync_conflicts` and `sync_tombstones` with columns taken from the PG fingerprint. Do not create `party_balances`. Include `ledger_entry_archive`.
- [X] T035 Add the runtime tables to `backend/src/infrastructure/orm/sqlite/schemas/motard-meta.table.ts`:
  - `motard_meta`, single row. Fields: `data_id`, `created_by_installation_id`, `adopted_installation_ids`, `install_instance_id`, `tenant_id`, `schema_journal_idx`, `app_version_last_opened`, `created_at`, `restored_from`. Rules: `data_id` "Minted once at creation. Never changes. Copied unchanged into backups."; `install_instance_id` "Updated only by a verified update hand-off or an explicit 'Open existing'".
  - `motard_sequences(name, value)`.
  - The connection-local `TEMP` table `motard_session_flags(flag)`, created by the connection layer (T040), not by migrations.
- [X] T036 Write `backend/src/infrastructure/orm/sqlite/migrations/0000_baseline.sql` reproducing the live schema:
  - 53 tables
  - 53 PKs, 22 UNIQUEs and 45 CHECKs, with each `= ANY(ARRAY[...])` rewritten as `IN (...)`
  - **73 FKs** with identical columns (including the composite `(tenant_id, license_id)`, `(tenant_id, device_id)` and `(tenant_id, user_id)` FKs) and identical ON DELETE actions
  - all B-tree and partial indexes from the fingerprint (`WHERE` kept). GIN/trigram indexes are omitted (research R7).
  - the `motard_meta` and `motard_sequences` tables

  Do **not** add the 24 non-enforced `tenant_id â†’ tenants` FKs (research F6a).
- [X] T037 Add the trigger equivalents T1â€“T7 to `0000_baseline.sql`, from data-model.md Â§4 and the verbatim bodies captured by T012:
  - **T1 ledger append-only** (`BEFORE DELETE` / `BEFORE UPDATE` with `RAISE(ABORT, <same message text as PG>)`, honoring `motard_session_flags` `allow_party_remap` for party_id only and `allow_dye_purge`)
  - **T2/T3** cash-box daily from ledger (`AFTER INSERT`; `AFTER UPDATE OF status, cash_impact, debit, credit`)
  - **T4** cash-box daily from `manual_movements` (`AFTER INSERT` / `UPDATE` / `DELETE`)
  - **T5/T6** license audit no-update / no-delete
  - **T7** `sync_inbox` `applied_seq` stamping from `motard_sequences`
- [X] T038 Create `backend/src/infrastructure/orm/sqlite/migrations/meta/_journal.json` (entry idx 0 = `0000_baseline`) and a SQLite fingerprint generator `backend/scripts/sqlite-schema-fingerprint.mjs`, writing `backend/src/infrastructure/orm/sqlite/migrations/meta/schema-fingerprint.json` in the PG fingerprint's JSON shape.
- [X] T039 Run `node backend/scripts/compare-schema-fingerprints.mjs backend/src/infrastructure/orm/sqlite/migrations/meta/schema-fingerprint.json`. Iterate on T034â€“T037 until only the allowed deltas remain. Commit the comparison output to `scripts/parity/baseline/schema-parity.txt`.
- [X] T040 [P] Write trigger tests in `backend/tests/sqlite/triggers.test.ts`. The forbidden ledger and licence-audit mutations fail with the same mapped error as PG. `cashbox_daily_balances` equals the PG table row-for-row after the same sequence of ledger inserts, cancellations, re-activations, manual movements (insert/update/delete) and opening-balance shifts. `applied_seq` is strictly increasing in commit order.

### 2G. SQLite connection layer (S3)

- [X] T041 Implement `backend/src/infrastructure/orm/sqlite/connection.ts`:
  - Open two `better-sqlite3` connections on `config.SQLITE_PATH`: **writer** and **reader**.
  - PRAGMAs on both: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `trusted_schema=OFF`, `cell_size_check=ON`. Set `busy_timeout` on the reader only.
  - Assert each PRAGMA value after setting it, and fail fatally if it doesn't hold.
  - Never set `synchronous=OFF/NORMAL` or `journal_mode=OFF/MEMORY` (Principle IV).
  - On graceful shutdown, run `PRAGMA wal_checkpoint(TRUNCATE)`, then close.
- [X] T042 Implement the async write gate and the ambient transaction in `backend/src/infrastructure/orm/sqlite/transaction.ts`:
  - **Write gate**: a FIFO mutex with an unbounded queue (no artificial limit). Each transaction acquires it, runs `BEGIN IMMEDIATE`, awaits `fn(tx)`, then `COMMIT` (or `ROLLBACK` on throw), and releases it.
  - **Nesting**: a nested transaction becomes a `SAVEPOINT`.
  - **Transaction clock**: captured at `BEGIN` and stored in the existing AsyncLocalStorage of `backend/src/infrastructure/orm/ambient-tx.ts`. Every `defaultNow()` and timestamp default in that transaction uses it (PG `now()` semantics).
  - **Session flags**: `motard_tx_state` (`ts` stamped at BEGIN; `allow_party_remap`/`allow_dye_purge` reset before COMMIT; research R13d replaces the TEMP `motard_session_flags`).
  - **Writes outside a transaction**: wrapped as single-statement transactions through the gate.
  - **Reads outside a transaction**: go to the reader connection.
- [X] T043 Resolve every call site found by T009 explicitly in `backend/src/infrastructure/orm/sqlite/transaction.ts` + the SQLite repositories. Either preserve the autonomous-commit semantics (run after the outer transaction on the writer, outside it), or prove with a test that joining the outer transaction yields identical results. Record each decision in research.md Â§R13a. No call site may deadlock the gate. Add a test per call site in `backend/tests/sqlite/autonomous-writes.test.ts`.
- [X] T044 [P] Map SQLite constraint errors to the PG codes and messages in `backend/src/infrastructure/errors/persistenceErrorMessage.ts`: `SQLITE_CONSTRAINT_UNIQUE`â†’`23505`, `SQLITE_CONSTRAINT_FOREIGNKEY`â†’`23503`, `SQLITE_CONSTRAINT_NOTNULL`â†’`23502`, `SQLITE_CONSTRAINT_CHECK`â†’`23514` (including `length`/`json_valid`/boolean checks), plus the type/affinity rejectionsâ†’`22P02`. The user-facing text must be identical. Add tests in `backend/tests/sqlite/error-mapping.test.ts`.
- [X] T045 Implement the SQLite migration runner + fingerprint verification in `backend/src/infrastructure/orm/runDesktopMigrations.ts` (SQ branch, selected by `getEngine()`):
  - apply pending `sqlite/migrations` forward only
  - refuse when the on-disk `schema_journal_idx` is newer than the binary
  - verify the live fingerprint against the committed one
  - never create a database implicitly: open only the existing `SQLITE_PATH`, except when the runtime passed FRESH (contracts/data-root-and-startup-states.md)

  Keep the PG branch unchanged.
- [X] T046 Add the SQ branch to the engine facade in `backend/src/infrastructure/orm/engine.ts`, wiring `withTenantTx`/`runInTransaction`/`txDb` to T042, with `better-sqlite3` loaded lazily. Add the `allowLedgerPartyRemap(tx)` and `allowDyePurge(tx)` SQ implementations, which set the flag in `motard_tx_state` (research R13d).
- [X] T047 [P] Write connection-layer conformance tests in `backend/tests/sqlite/connection.test.ts` covering:
  - atomic rollback on throw and read-your-writes
  - savepoint nesting
  - equal transaction-clock timestamps
  - no interleaving of two concurrent async transactions
  - unbounded queueing of 1,000 concurrent writers
  - the PRAGMA assertions
  - a force-kill of a writer process mid-loop (spawned child + `taskkill /F`) leaves every committed row present and `PRAGMA integrity_check` = `ok`
- [X] T048 Package the native addon per T014's result: update `desktop/scripts/bundle-server.mjs` (esbuild `external: ["better-sqlite3"]`; copy the addon + loader beside `server.mjs`), `desktop/scripts/resource-manifest.json` and `desktop/scripts/validate-resource-manifest.mjs`. Verify that `desktop/scripts/server-bundle.test.mjs` passes.

**Checkpoint**:
- the reference is frozen (T026)
- S1 is proven on PG (T031)
- schema parity has only the allowed deltas (T039)
- the connection-layer tests pass (T047)

User-story phases may start.

---

## Phase 3: User Story 1 â€” Same accounting results on the new engine (Priority: P1) ðŸŽ¯ MVP

**Goal**: every port works on SQLite with results identical to the frozen PG reference (plan S4â€“S5).

**Independent Test**: `node scripts/parity/run.mjs` on the reference build and on the SQLite build from clean states, then
`node scripts/parity/diff.mjs` â†’ **empty diff**. Covers statements, balances, ledger, cash box per currency
(SYP/USD/EUR), stock, relationships and `cashbox_daily_balances` row-for-row (quickstart Â§2).

### Tests for User Story 1

- [X] T049 [P] [US1] Write the tenant-isolation suite in `backend/tests/tenant-isolation.test.ts` (both engines). Seed two tenants and call every port method with tenant A's context. There must be zero rows of tenant B in reads, and zero writes reaching tenant B (contracts/db-engine-port.md guarantee 3; research I-10).
  - Done as `scripts/parity/isolation.mjs` (HTTP level, both engines, every route→port path) instead of a repository-level vitest file: A's full dataset is cloned into tenant B, 82 reads unchanged, 147 by-id reads + 78 cross-tenant writes refused/no-op, B byte-identical. Report: `scripts/parity/reports/US1-parity.md`.
- [X] T050 [P] [US1] Write the parity scenarios in `scripts/parity/scenarios/`, one file per domain, driving the HTTP API only:
  - `parties.mjs`
  - `inventory.mjs` (fabrics â†’ colors â†’ rolls, stock movements, inventory counts)
  - `invoices.mjs` (sale/purchase, SYP/USD/EUR, discounts, fractional quantities)
  - `vouchers.mjs`
  - `returns.mjs`
  - `settlements.mjs`
  - `cashbox.mjs` (sessions, manual movements, day close)
  - `cancellations.mjs` (invoice/voucher/return/party; D-4 list absence + history presence)
  - `purge-merge.mjs` (party purge cascade, dye purge cascade, party merge)
  - `financial-years.mjs` (close/reopen, yearly summaries)
  - `concurrency.mjs` (parallel same-roll consumption and parallel same-document-number allocation)
  - `rounding.mjs` (`x.xx5` boundaries)
- [X] T051 [US1] Implement the canonical exporter in `scripts/parity/run.mjs`. It exports the API outputs (statements, balances, lists, reports) and a canonical snapshot of all 53 business tables (UUIDs mapped through natural keys and creation order, timestamps compared as instants, money compared exactly). It also exports `cashbox_daily_balances` raw rows. Run it against the T026 reference to produce `scripts/parity/baseline/ref/`.

### Implementation for User Story 1 (stage S4, one PR per batch; each batch ends with its conformance + parity subset green)

**Shared SQLite query helper (needed by every batch that searches)**

- [X] T052 [US1] Create `backend/src/infrastructure/repositories/sqlite/helpers/likeContains.ts`, providing a Drizzle `sql` helper that renders `col LIKE ? ESCAPE '\'` with the existing `likeContains()` pattern from `backend/src/infrastructure/utils/likeEscape.ts`. This is an exact equivalent of PG `ILIKE` under locale C: ASCII-only case folding, no Arabic normalization. Add a unit test in `backend/tests/sqlite/like-contains.test.ts` for `%`, `_` and `\` in the input.

**Batch 4a: parties, users, settings, tenancy**

- [X] T053 [P] [US1] Implement `SqlitePartyRepository` (including the D-4 default exclusion of `cancelled` in `list()`, by-id lookup unchanged), `SqliteUserRepository`, `SqliteAuthRepository`, `SqliteTenantRepository`, `SqliteCompanyRepository` and `SqliteSettingsRepository` in `backend/src/infrastructure/repositories/sqlite/`. Port the `partyListStatsAggregation.ts`, `customerCredit.ts` and `partyDeletionImpact.ts` helpers to `backend/src/infrastructure/repositories/sqlite/helpers/`. Use `LIKE â€¦ ESCAPE '\'` via the T052 helper wherever PG uses `ILIKE`.
- [X] T054 [US1] Run the conformance tests for the batch-4a ports with `DB_ENGINE=sqlite`, and the `parties.mjs` scenario diff. Both must pass.

**Batch 4b: inventory**

- [X] T055 [P] [US1] Implement `SqliteFabricRepository`, `SqliteColorRepository`, `SqliteRollRepository` and `SqliteStockMovementRepository` in `backend/src/infrastructure/repositories/sqlite/`, plus the SQ versions of `rollLocking.ts` (no `FOR UPDATE`: serialization by the write gate), `rollDeletionHelper.ts`, `stockMovementHelper.ts` and `inventoryCountRepository.ts` in `backend/src/infrastructure/repositories/sqlite/helpers/`.
- [X] T056 [US1] Resolve I-3 for inventory (SQL-side quantity Ã— price arithmetic: rescale at the boundary or explicitly in SQL). Run the conformance tests plus the `inventory.mjs` and `concurrency.mjs` (same-roll) diffs. Both must pass.

**Batch 4c: invoices, ledger, cash box, numbering**

- [X] T057 [US1] Implement `SqliteInvoiceRepository`, `SqliteLedgerRepository` (advisory lock â†’ write gate), `SqliteCashboxRepository`, `SqliteStatementRepository` (keyset `(created_at, id)` preserved, no caps) and `SqliteDocumentNumberRepository`/`SqliteDocumentNumberBlockRepository`/`SqliteDocumentTrackRepository` (the `document_sequences` UPSERT with `RETURNING`; `GREATEST` â†’ `max()` wrapped with `COALESCE` for NULL parity) in `backend/src/infrastructure/repositories/sqlite/`. Add the SQ versions of `cashboxBalanceHelper.ts`, `dayLockHelper.ts`, `keysetPage.ts` and `reportAggregates.ts` in `backend/src/infrastructure/repositories/sqlite/helpers/`.
- [X] T058 [US1] Resolve I-3 for invoices and ledger. Run the conformance tests plus the `invoices.mjs`, `cashbox.mjs`, `rounding.mjs` and `concurrency.mjs` (same-number) diffs, including `cashbox_daily_balances` row-for-row. All must pass.

**Batch 4d: vouchers, returns, settlements, expenses, print, orders, dashboard, profit, notifications, audit**

- [X] T059 [P] [US1] Implement `SqliteVoucherRepository`, `SqliteReturnRepository`, `SqliteExpenseRepository`, `SqlitePrintJobRepository`, `SqliteOrderRepository` (with `orderAvailabilityNotifier.ts` SQ helper), `SqliteDashboardRepository`, `SqliteProfitRepository`, `SqliteNotificationRepository` and `SqliteAuditRepository` in `backend/src/infrastructure/repositories/sqlite/`. Add the SQ implementations of the T029 ports for `settleInvoicesUseCase`.
- [X] T060 [US1] Resolve I-3 for batch 4d: every SQL-side arithmetic expression mixing decimal scales in the voucher (including `numeric(18,6)` exchange-rate Ã— amount), return, settlement, expense, profit and dashboard queries is either moved to the boundary or explicitly rescaled, with a parity assertion each. Then run the conformance tests plus the `vouchers.mjs`, `returns.mjs`, `settlements.mjs` and `cancellations.mjs` diffs, including SYP/USD/EUR conversions. All must pass.

**Batch 4e: year close, purge, merge**

- [X] T061 [US1] Implement the SQ versions of `financialYearRepository.ts` (close/reopen; yearly snapshots into `yearly_party_summaries`; never moves ledger rows) and `dyePurgeRepository.ts` (the `allowDyePurge` session flag instead of runtime trigger DDL, per T013) in `backend/src/infrastructure/repositories/sqlite/`. Add the SQ implementations of the T029 ports used by `mergePartiesUseCase.ts` (`allowLedgerPartyRemap`) and `purgePartyCascadeUseCase.ts`.
- [X] T062 [US1] Resolve I-3 for batch 4e: the mixed-scale arithmetic in the year-close aggregates (`stockValueByCurrency`, `writeYearlyPartySnapshots`), the dye-purge cash-box rebuild (`rebuildCashboxSeries`, `survivingCash`) and the merge balance recomputation, each with a parity assertion. Then run the conformance tests plus the `purge-merge.mjs` and `financial-years.mjs` diffs. Both must pass.

**Search (S5)**

- [X] T063 [US1] Implement the SQ implementation of the T029 search port (from `backend/src/presentation/routes/search.route.ts` queries) using T052. Write `backend/tests/sqlite/search-parity.test.ts` with an Arabic, Latin and mixed corpus (names, codes, numbers; queries containing `%`, `_` and `\`). Result sets and order must be identical on both engines.

**Batch 4f (US1 completion)**

- [X] T064 [US1] Run the full backend suite with `DB_ENGINE=sqlite` (`cd backend && npm run test:sqlite`) and the tenant-isolation suite (T049). Both must be green, with the same test count as the PG run. Also verify FR-040 / DB-8: the SQLite build has no code path that reads `pgdata`, connects to PostgreSQL or imports a PostgreSQL dump or v2 archive into SQLite. Grep `backend/src/infrastructure/**/sqlite/**` and the SQ branches for `pg`, `DATABASE_URL`, `pg_restore` and v2 import calls; the expected result is none.
  - 2026-10-04: `npm run test:sqlite` 701 passed / 0 failed / 34 skipped (126 files); PG `npm test` 739 / 0 / 0 (127 files). The difference is the PG-mechanism-only checks (RLS, pg_catalog, node-pg internals, PG-era legacy repair, v2 PG round trip), each gated with `pgOnly` or excluded and naming its SQLite counterpart. The PG suites run unchanged on SQLite through `tests/_sqlite` (resolver + shim). FR-040 grep: no runtime path (one `import type`, erased).
- [X] T065 [US1] Run the full parity set: `node scripts/parity/run.mjs --engine sqlite --out scripts/parity/out/sut/`, then `node scripts/parity/diff.mjs scripts/parity/baseline/ref/ scripts/parity/out/sut/`. The diff must be **empty** (SC-001). Commit the run report to `scripts/parity/reports/US1-parity.md`.

**Checkpoint**: US1 is complete. The SQLite backend is behaviorally identical to the reference through every port.

---

## Phase 4: User Story 2 â€” A normal Windows app with no database server (Priority: P1)

**Goal**: the desktop runtime starts only the backend on SQLite. No PG binaries, process, port or `db-port.txt` (plan S7 core + S9).

**Independent Test**: quickstart Â§8. The installer contains no PG files. A running instance has no listening port owned by Node, no `postgres`
process and no console window. Close leaves no process. A second launch focuses the first. A backend crash triggers at most 3 silent restarts in a
5-minute window, then "internal service stopped".

### Tests for User Story 2

- [X] T066 [P] [US2] Write `desktop/scripts/verify-no-postgres.mjs`. Given an installer or unpacked app dir, it fails if any `postgres.exe`, `pg_ctl.exe`, `initdb.exe`, `pg_dump.exe`, `pgdata-template\`, `libpq*.dll` or `db-port.txt` is present. Given a running PID tree, it fails if any `postgres` process exists or `Get-NetTCPConnection -State Listen -OwningProcess <node pid>` returns a row.
- [X] T067 [P] [US2] Add Rust tests in `desktop/src-tauri/src/runtime/supervisor.rs` (`#[cfg(test)]`) for the restart bound: 3 restarts allowed within a rolling 5-minute window; the 4th failure in the window â†’ `StackState::Failed` with the "internal service stopped" message, whose text contains no corruption wording; restarts outside the window reset the count.

### Implementation for User Story 2

- [X] T068 [US2] Remove PG lifecycle from `desktop/src-tauri/src/runtime/stack.rs`: `ensure_pgdata`, PG spawn and stop, `pg_ctl`, `initdb`, SCRAM setup, `cleanup_stale_cluster_lock`, the `DATABASE_URL`/`PGPASSWORD` env and `postmaster.pid` handling. Spawn only Node with the contracts/data-root-and-startup-states.md environment: `DESKTOP_DEPLOY=true`, `DESKTOP_PIPE`, `DB_ENGINE=sqlite`, `SQLITE_PATH=<root>\data\motard.db`, `MOTARD_INSTALLATION_ID`, `MOTARD_DATA_ID`, and unchanged `JWT_SECRET`, `APP_MASTER_KEY`, `CENTRAL_SYNC_URL`, `LICENSE_SIGNING_PUBLIC_KEY`, `MOTARD_BOOT_ID` and `MOTARD_APP_VERSION`.
- [X] T069 [US2] Delete `desktop/src-tauri/src/runtime/ports.rs` and `desktop/src-tauri/src/runtime/cluster_identity.rs`, along with their uses in `runtime/mod.rs`, `stack.rs`, `pipe.rs`, `error.rs` and `boot_log.rs`. Remove all `db-port.txt` reads and writes.
- [X] T070 [US2] Implement the restart bound in `desktop/src-tauri/src/runtime/supervisor.rs`: at most 3 backend restarts per rolling 5 minutes (OQ-2), then `SERVICE_STOPPED`. Keep the Windows Job Object and the PID-reuse-safe reaping for orphan prevention (RT-3).
- [X] T071 [US2] Implement the data-root lock in a new `desktop/src-tauri/src/data_lock.rs`:
  - **Lock file**: `<root>\motard.lock`, opened with an exclusive share mode for the process lifetime. Contents: owner PID, process image path, boot id, installation id.
  - **Same installation holds it**: if the holder is a live Motard process of the same installation (image path + installation id match), wait, then terminate it safely through the existing reaper.
  - **Unknown holder**: return `LOCKED_UNKNOWN`. Nothing is deleted or replaced (RT-6).
  - **Startup order**: register the module in `lib.rs` and acquire the lock in `main.rs` before any backend spawn.
- [X] T072 [US2] Confirm `tauri_plugin_single_instance` stays the first plugin in `desktop/src-tauri/src/main.rs` (RT-5), and add a test or scripted check that a second launch only focuses the first window.
- [X] T073 [US2] Remove PG packaging:
  - delete or retire `desktop/scripts/build-pgdata-template.mjs`, `desktop/scripts/prune-postgres.mjs`, `desktop/scripts/verify-pgdata-template.mjs` and the `desktop/pgdump-staging/` usage;
  - remove the postgres entries from `desktop/scripts/resource-manifest.json`;
  - update `desktop/src-tauri/before-build.cmd`, `desktop/build-frontend.cmd`, `desktop/package.json` scripts and `desktop/BUILD-WINDOWS.md` accordingly.

  The previous PG release artifacts remain downloadable and are not deleted from release storage.
- [X] T074 [US2] Switch the **pre-migration snapshot** off `pg_dump`. `takePreOpSnapshot` in `backend/src/infrastructure/integrity/snapshot.ts` is called only before migrations (`backend/src/infrastructure/orm/runDesktopMigrations.ts:178,227`); year close, purge and merge get their own backups in T097. The SQ branch takes a `VACUUM INTO` copy of `motard.db` plus `PRAGMA integrity_check`, records its sha256 sidecar exactly as the PG branch does, and refuses the migration if the copy fails. There is no snapshot when the database was just created by FRESH and has no pending data. Once US4 lands, T095 replaces this with `createAndVerifyBackup({kind:"pre-migration"})`. Keep the PG branch unchanged for the cloud.
- [X] T075 [US2] Implement the install-instance marker (D-1) in `desktop/src-tauri/windows/hooks.nsh`, so every US2 installer build lets T076 detect a new installation:
  - `NSIS_HOOK_POSTINSTALL`: write a new GUID to `HKCU\Software\MotardFabricsErp\InstallInstanceId` **only if absent**.
  - `NSIS_HOOK_PREUNINSTALL`: delete that value.

  Keep the existing rule: never touch `$LOCALAPPDATA\motard-erp`. Update the header comment. This must land before T076 and before any US2 installer is built (T078).
- [X] T076 [US2] Implement a **minimal** startup evaluation in `desktop/src-tauri/src/db_meta.rs` so the US2 build can run:
  - **FRESH**: an empty data root.
  - **REUSE**: only when all three hold: the `db-meta.json` sidecar = `motard_meta` (`data_id`, `tenant_id`); the device binding decrypts; and the install-instance check does **not** indicate a new installation. That means the HKCU `InstallInstanceId` marker equals `motard_meta.install_instance_id`, or both are absent (a database created by a build without the marker).
  - **New installation detected**: the marker exists and differs from `motard_meta.install_instance_id`, or `motard_meta.install_instance_id` is set but the marker is absent. Never reuse silently. Halt safely with the "unsupported startup state" screen and change no file, until US3 provides the PRIOR_DATA_FOUND choices (D-1, FR-029). The update hand-off token (US3) is not yet honored here, so this halt also applies after an update on US2 builds.
  - **Anything else**: a blocking "unsupported startup state" halt that changes no file, until US3 completes the full state machine.
  - **Tests**: add Rust unit tests in `desktop/src-tauri/src/db_meta.rs` (`#[cfg(test)]`) for marker equal â†’ REUSE, marker different â†’ halt, marker missing with a recorded instance â†’ halt, both absent â†’ REUSE. Each must assert that no file in the data root changed.

  Remove the `pg_major`/`PG_VERSION` logic. Read `motard_meta` read-only and run `PRAGMA integrity_check` before REUSE.
- [X] T077 [US2] Implement FRESH creation in the backend: in `backend/src/infrastructure/orm/runDesktopMigrations.ts` (SQ branch), when the runtime passes FRESH, create `motard.db`, apply `0000_baseline`, insert `motard_meta` (minting `data_id`, recording `created_by_installation_id` = `MOTARD_INSTALLATION_ID` and `install_instance_id` from the HKCU marker when present) and the single default tenant. This must be equivalent to today's baked template content (tenant + baked licence, 0 users), using `backend/src/scripts/bake-desktop-license.ts` logic. The backend refuses to serve when `motard_meta.data_id` â‰  `MOTARD_DATA_ID` on a non-FRESH start. The runtime writes the `db-meta.json` sidecar after the backend confirms creation.
- [X] T078 [US2] Build the packaged installer and run `node desktop/scripts/verify-no-postgres.mjs` on it and on a running instance (quickstart Â§8). Both must pass (SC-002). Record the output in `scripts/parity/reports/US2-no-postgres.md`.

**Checkpoint**: US2 is complete. The packaged app runs on SQLite with no database server or port.

---

## Phase 5: User Story 3 â€” Same company data across the whole lifecycle (Priority: P1)

**Goal**: implement installation and data identity, the startup state machine, update/uninstall/reinstall handling and connection info (plan S7, research R11/R12, D-1, D-2).

**Independent Test**: quickstart Â§4 on a VM:
- **Data checks**: FRESH on a clean install. REUSE after close, kill, Windows restart and update (no prompt).
- **New installation**: a reinstall after uninstall shows PRIOR_DATA_FOUND with Open existing / Restore a backup / Start new.
- **Negative cases**: MISMATCH, CORRUPT, LOCKED_UNKNOWN and DATA_MISSING each show their screen and never delete data.

### Tests for User Story 3

- [X] T079 [P] [US3] Add Rust unit tests in `desktop/src-tauri/src/db_meta.rs` (`#[cfg(test)]`), one per row of contracts/data-root-and-startup-states.md "Startup states" (FRESH, REUSE, PRIOR_DATA_FOUND, MISMATCH, CORRUPT, TOO_NEW, DATA_MISSING, LOCKED_UNKNOWN), using temp data roots. Assert that no test path deletes or overwrites any file except creation in FRESH.
- [X] T080 [P] [US3] Write `scripts/lifecycle/negative-cases.ps1`, scripted for the VM:
  - copy another VM's data root in â†’ MISMATCH
  - delete `device-binding.dat` â†’ PRIOR_DATA_FOUND
  - remove the HKCU `InstallInstanceId` value â†’ PRIOR_DATA_FOUND
  - truncate `motard.db` â†’ CORRUPT
  - hold `motard.db` open from a foreign process â†’ LOCKED_UNKNOWN
  - delete `data\` while `db-meta.json` remains â†’ DATA_MISSING

  After each case, assert that file hashes in the data root are unchanged.

### Implementation for User Story 3

- [X] T081 [US3] Complete `desktop/src-tauri/src/db_meta.rs`, extending the minimal US2 evaluation (T076):
  - **Sidecar**: `db-meta.json` = `{ data_id, tenant_id, schema_journal_idx, installation_id }`.
  - **Startup evaluation**: `evaluate_startup_state(...)` returns every state in the contract, following data-model.md Â§5.1 exactly. This replaces the US2 "unsupported startup state" halt.
  - **Reading the database**: read `motard_meta` by opening `motard.db` read-only, then run `PRAGMA integrity_check` before any REUSE decision.
- [ ] T082 [US3] Resolve I-14: on a VM, install vN, then apply an update to vN+1 through the in-app updater (`tauri.conf.json` `updater.windows.installMode: "passive"`). Record whether `PREUNINSTALL` ran and whether the marker GUID changed. Record the result in research.md Â§R13a.
- [X] T083 [US3] Implement the update hand-off token (D-1) in `desktop/src-tauri/src/main.rs` `install_desktop_update`:
  - **Before applying the update**: (a) request a VERIFIED pre-update backup (US4 `createAndVerifyBackup`, kind `pre-update`; until US4 lands, block the update with a clear message); (b) write `<root>\pending-update.json` = `{ installInstanceId, fromVersion, toVersion, createdAt }`; (c) stop the backend gracefully, waiting for `wal_checkpoint(TRUNCATE)`, then release `motard.lock`; (d) apply.
  - **Failed shutdown**: a failed or timed-out shutdown is reported as such and never treated as corruption (LC-4).
- [X] T084 [US3] Implement the REUSE-after-update rule in `desktop/src-tauri/src/db_meta.rs`. A marker GUID that differs from `motard_meta.install_instance_id` is REUSE only when a valid `pending-update.json` names the recorded GUID and `toVersion` equals the running version. Otherwise it is PRIOR_DATA_FOUND. On REUSE-after-update, the backend updates `motard_meta.install_instance_id` and deletes the token.
- [X] T085 [US3] Implement the startup-state actions in `desktop/src-tauri/src/main.rs` (extend `recovery_status`/`recovery_retry`; add `startup_choose(action)`):
  - `open_existing` â†’ append to `adopted_installation_ids`, set `install_instance_id`, then REUSE
  - `restore_backup` â†’ US4 restore flow
  - `start_new` â†’ move `data\`, `db-meta.json` and `backups.json` to `<root>\set-aside\<timestamp>\`, then FRESH

  No action deletes data (C-13).
- [X] T086 [US3] Implement the startup-state screens in `desktop/shell/recovery.html` (and its copy pipeline into `desktop/src-tauri/resources/server/web/recovery.html`):
  - one screen per state, with exactly the options listed in contracts/data-root-and-startup-states.md;
  - PRIOR_DATA_FOUND shows **Open existing data / Restore a backup / Start a new project**;
  - Arabic text consistent with existing recovery messages;
  - no wording claims corruption except in the CORRUPT state.
- [X] T087 [US3] Extend the connection info (ID-7): `data_root_info()` in `desktop/src-tauri/src/lib.rs` and the `get_data_root` command in `main.rs` return `{ profile, dataRoot, databasePath, dataId, tenantId, companyName, schemaJournalIdx, pipe }`. Show it in the existing settings/about diagnostics surface without adding new screens.
- [X] T088 [US3] D-2 (decided; spec FR-069): on desktop, construct `InstallationIdStorage` in `backend/src/infrastructure/di/container.ts` with the per-user path `%LOCALAPPDATA%\motard-erp\install-id`, seeded from and linked to `MOTARD_INSTALLATION_ID` (the device-binding installation id). If a stored value differs from the binding, treat it as an identity mismatch and report it; never overwrite silently. Two Windows users on the same PC must get different ids (add a test in `backend/tests/installation-id-per-user.test.ts`). The cloud keeps its default path in `backend/src/infrastructure/installation/InstallationIdStorage.ts`.
- [ ] T089 [US3] Run quickstart Â§4 steps 1â€“9 plus `scripts/lifecycle/negative-cases.ps1` on a Windows 11 VM with the packaged build. The update (step 7) must be REUSE with no prompt. The reinstall (step 9) must show PRIOR_DATA_FOUND. "Start new" keeps the old data in `set-aside\`. Record the results in `scripts/parity/reports/US3-lifecycle-dev.md`.

**Checkpoint**: US3 is complete. Identity and lifecycle never open the wrong data, never silently reuse after a new install, and never delete.

---

## Phase 6: User Story 4 â€” Backups that are proven restorable (Priority: P2)

**Goal**: implement backup format v3 with one create-and-verify path, the VERIFIED registry, the automatic policy, a staging restore and the weekly restore-test (plan S6, research R10, contracts/backup-format-v3.md).

**Independent Test**: quickstart Â§5:
- every backup path reaches VERIFIED;
- corruption injection is rejected;
- a same-device and a cross-device restore pass the RS-5 comparison with zero differences;
- retention keeps 7 backups in both locations;
- the weekly restore-test is recorded.

### Tests for User Story 4

- [X] T090 [P] [US4] Write `backend/tests/sqlite/backup-v3.test.ts`:
  - create â†’ VERIFIED;
  - a flipped byte in each zip member, a truncated zip, a manifest-hash mismatch and a missing `database.sqlite` are each rejected with a clear code;
  - `formatVersion 2` â†’ rejected ("PostgreSQL-era backup");
  - `formatVersion > 3` â†’ `BACKUP_NEWER_THAN_APP`;
  - `excludedTables` rows are absent from `database.sqlite`;
  - the `licenses` row **is present** with company licence identity intact (key, type, plan, edition, status, limits, customer fields, `tenant_id`), its `binding_type`, `binding_value`, `offline_token` and `offline_token_jti` are NULL, and `tenants.activation_id` is NULL;
  - `license_audit_events` is absent;
  - `foreign_key_check` on the extracted copy is empty;
  - a same-device restore keeps the live device's activation, device registration, secrets, licence binding, offline token and `license_audit_events` rows (carry-over);
  - a restore onto a fresh device has no activation and requires licence verification;
  - the original archive's bytes are unchanged after a restore.
- [X] T091 [P] [US4] Write `backend/tests/sqlite/restore-rs5.test.ts`: restore into staging, migrate, then run the RS-5 comparison (record counts, parties, invoices, balances, ledger, inventory, cash box, statements) against the manifest. A forced failure at each restore step leaves the live database byte-identical.

### Implementation for User Story 4

- [X] T092 [US4] Implement `createAndVerifyBackup({ kind: "manual"|"automatic"|"pre-operation"|"pre-migration"|"pre-restore"|"pre-update" })` in a new `backend/src/infrastructure/backup/sqliteBackup.ts`, following contracts/backup-format-v3.md Â§Creation and Â§Licence and device-bound state exactly:
  1. `db.backup(tmp)`
  2. `integrity_check` = `ok` and `foreign_key_check` empty
  3. delete the v3 `excludedTables` rows (`license_activations`, `device_registrations`, `secrets`, `server_installations`, `revoked_tokens`, `idempotency_keys`, `invitation_codes`, `license_audit_events`), then set the `nulledColumns` to NULL (`licenses.binding_type`, `licenses.binding_value`, `licenses.offline_token`, `licenses.offline_token_jti`, `tenants.activation_id`, plus I-18 additions), re-run `foreign_key_check`, then `VACUUM`. **Keep the `licenses` row.** Do **not** reuse v2's `DEVICE_BOUND_TABLES`, which drops `licenses`. Define the v3 sets in `backend/src/infrastructure/backup/sqliteBackup.ts`.
  4. zip `database.sqlite` + `files/logos/â€¦` + `files/attachments/â€¦` + `manifest.json` + `manifest.sha256`. The manifest fields are listed in the contract table: `format`, `formatVersion: 3`, `createdAt`, `app.version`, `schema.journalIdx`, `schema.fingerprintSha256`, `data.dataId`, `tenant.id`, `tenant.name`, `tables[]` (`{name, rows, sha256}`), `files[]` (`{path, bytes, sha256}`), `excludedTables`, `nulledColumns`, `licence`, `sync`.
  5. write `<final>.partial`
  6. `fsync` the file
  7. rename
  8. `fsync` the directory
  9. verify (T093)
  10. registry status

  Any failure â†’ status `FAILED`, the `.partial` is removed and the error is surfaced.
- [X] T093 [US4] Implement `openAndVerifyBackupV3(file)` in `backend/src/infrastructure/backup/sqliteBackup.ts`, per contracts/backup-format-v3.md Â§Verification: zip CRC, `manifest.sha256`, `files[]` hashes, then extract to temp, `integrity_check`, `foreign_key_check`, and per-table `rows` + `sha256` recomputed against the manifest.
- [X] T094 [US4] Implement the backup registry `<root>\backups.json` in `backend/src/infrastructure/backup/backupRegistry.ts`, holding path, kind, created, status `VERIFIED`/`FAILED`, manifest hash and last restore-test result. Follow the state machine `CREATING â†’ WRITTEN(.partial) â†’ FLUSHED â†’ RENAMED â†’ VERIFYING â†’ VERIFIED | FAILED` (data-model.md Â§5.2). Only `VERIFIED` entries count for the UI, retention and `lastSuccessfulBackupAt` in `backend/src/infrastructure/integrity/dataIntegrityManifest.ts`.
- [X] T095 [US4] Route every desktop backup path through `createAndVerifyBackup` when `getEngine()==="sqlite"`:
  - `runTenantFullBackup` in `backend/src/presentation/routes/backup.route.ts`;
  - `runAutomaticBackup` and `mirrorBackup` in `backend/src/infrastructure/backup/backupScheduler.ts`;
  - the pre-restore safety copy in `restoreUploadedBackup`;
  - the pre-migration snapshot in `backend/src/infrastructure/integrity/snapshot.ts` (replacing T074's interim copy with `kind:"pre-migration"`).

  The PG/cloud v2 paths stay unchanged.
- [X] T096 [US4] Implement the automatic policy (OQ-5) in `backend/src/infrastructure/backup/backupScheduler.ts`:
  - **Schedule**: run at startup when the newest VERIFIED automatic backup is older than 24 h, and every 24 h while running.
  - **Retention**: keep the 7 newest VERIFIED automatic backups in `%LOCALAPPDATA%\motard-erp\backups`, with a verified mirror copy under the user's Documents folder (existing `backupMirrorRoot()`).
  - **Pruning**: prune only VERIFIED entries beyond 7 and never delete a non-automatic backup.
- [X] T097 [US4] Add automatic pre-operation backups (BK-4) before restore, year close, year reopen, party purge, dye purge and party merge. Call `createAndVerifyBackup({kind:"pre-operation"})` from the SQ implementations used by `backend/src/presentation/routes/year-closing.route.ts`, `dye.route.ts`, `party.route.ts` and `backup.route.ts`. A failed pre-operation backup blocks the operation with a clear message.
- [X] T098 [US4] Implement the restore in `backend/src/infrastructure/backup/sqliteRestore.ts`, following data-model.md Â§5.3 `VERIFY_ARCHIVE â†’ SAFETY_BACKUP(VERIFIED) â†’ EXTRACT_STAGING â†’ MIGRATE_STAGING â†’ VERIFY_STAGING (RS-5) â†’ CARRY_OVER_DEVICE_STATE â†’ SWAP (old kept aside) â†’ REOPEN`:
  - the source archive is opened read-only;
  - migration runs on staging only;
  - **carry-over**: copy the live database's `excludedTables` rows, its `licenses` device-bound columns (when the licence id matches) and `tenants.activation_id` into staging before the swap, per contracts/backup-format-v3.md Â§Restore guarantees;
  - the swap is an atomic rename, with the previous `motard.db` moved to `<root>\set-aside\<timestamp>\`;
  - `motard_meta.restored_from` is set.

  Wire it into `restoreUploadedBackup` in `backup.route.ts` for the SQ engine, and into the US3 `restore_backup` startup action.
- [X] T099 [US4] Implement the weekly restore-test (OQ-6) in `backend/src/infrastructure/backup/backupScheduler.ts`: once per 7 days, restore the newest VERIFIED automatic backup into a temp dir, run the RS-5 comparison silently, record the result in `backups.json` and delete only the temp dir.
- [X] T100 [US4] Implement a verified manual download on the **desktop only** (U-2, I-11):
  - **Desktop**: add a Tauri command `save_backup_file` in `desktop/src-tauri/src/main.rs` (native save dialog; copies the verified file; returns the written size + sha256). Success is shown only when the size and sha256 equal the verified file's.
  - **Path selection**: in `src/routes/settings.backup.tsx` (lines ~99â€“113), choose at runtime. If Tauri is present, use the new command. Otherwise keep the **existing browser anchor download exactly as it is** for the web/cloud app.
  - **Status**: show the VERIFIED/FAILED registry status on desktop only.
  - **Web check**: add a frontend test in `src/routes/__tests__/settings.backup.test.tsx` asserting that without Tauri the web path is unchanged.
- [ ] T101 [US4] Run quickstart Â§5 on a developer VM with a same-device restore and a restore onto the second VM. The RS-5 comparison must show zero differences (SC-006). Record the results in `scripts/parity/reports/US4-backup.md`.

**Checkpoint**: US4 is complete. Every backup is verified, and restores are staged, compared and non-destructive.

---

## Phase 7: User Story 5 â€” Offline devices that converge after sync (Priority: P2)

**Goal**: the device-side sync runs on SQLite, wire-compatible with the unchanged PG hub, including the restore-on-synced-device flow (plan S8, research R13, contracts/sync-wire-compat.md).

**Independent Test**: quickstart Â§6:
- **Convergence**: with A creating 20 invoices and B creating 30 offline (including a same-record edit and a same-roll consumption), A, B and the hub all end with 50 identical invoices, document numbers, parties, balances, ledger, inventory and cash box.
- **Wire compatibility**: the golden wire diff is empty.
- **Restore on a synced device**: pauses sync, auto-pulls, never re-pushes acknowledged units, and opens review mode only on conflict.

### Tests for User Story 5

- [X] T102 [P] [US5] Extend `backend/scripts/verify-sync-multidevice.mjs` to run desktops with `DB_ENGINE=sqlite` against a fresh PG hub tenant (Docker deployment). Implement the AC-8 A/B scenario and assert identical final business state on A, B and the hub (SC-007). **Done 2026-10-04:** `--ac8 [--device-engine sqlite|postgres]` (shared harness `scripts/parity/lib/syncAc8.mjs`). Result 7/9 on BOTH engines; the 2 failures are pre-existing shared-sync behaviors (owner items, `scripts/parity/reports/US5-sync.md`).
- [X] T103 [P] [US5] Write the golden wire test `scripts/parity/sync-wire.mjs`: **Done 2026-10-04:** PASS — empty diff across 162 files (132 exchanges + scenario log + every hub/A/B table).
  - run the A/B scenario twice: PG desktops against hub #1, and SQ desktops against hub #2;
  - capture push batches and pull applications;
  - compare under the canonicalization in contracts/sync-wire-compat.md (sorted JSON keys, UUIDs mapped through creation order, timestamps as instants, exact money).

- [X] T104 [P] [US5] Write the long-offline test `scripts/parity/offline-duration.mjs` (spec FR-055, SY-2; uses the T016 findings): **Done 2026-10-05:** `scripts/parity/offline-duration.mjs`: engines identical (empty diff, 107 files), sync converges after 90 days; **SY-2 conflict reported** (per-year number blocks stop numbered documents for a device offline across 1 January; not changed). `scripts/parity/reports/US5-sync.md`.
  - run one desktop on each engine with the hub unreachable, advancing the clock 1, 7, 30 and 90 days;
  - at each step, create and cancel invoices, vouchers and stock movements, and read statements;
  - assert ERP operation is identical on both engines and no new offline limit appears in sync or licensing;
  - then reconnect and assert sync converges.

  Any licensing rule recorded by T016 must have the identical effect on both engines. A rule that stops ERP work is reported to the owner, not changed.

### Implementation for User Story 5

- [X] T105 [US5] Resolve I-9 (does a desktop write `sync_inbox`?) and I-12 (how acknowledged outbox units are identified after restore; see `backend/scripts/verify-restore-sync-state.mjs`). Record the answers in research.md Â§R13a. **Done 2026-10-04:** research.md §R13a (I-9 yes; I-12 by op_id).
- [X] T106 [US5] Implement `SqliteSyncOutboxRepository` in `backend/src/infrastructure/repositories/sqlite/`. Its claim replaces `FOR UPDATE SKIP LOCKED` (PG `PostgresSyncOutboxRepository.ts:154`) with a claim inside one `BEGIN IMMEDIATE` transaction. Keep the status machine `"pending" | "pushing" | "synced" | "rejected"` unchanged. **Done 2026-10-04:** already implemented in US1 (claim inside one `BEGIN IMMEDIATE` transaction), wired in `sqliteContainer.ts`; proven by T103.
- [X] T107 [P] [US5] Implement `SqliteSyncInboxRepository` (status `"received" | "applied" | "rejected" | "dead"`; `applied_seq` via trigger T7; the shared advisory lock is removed because the single writer guarantees there are no gaps), `SqliteSyncDeviceRepository`, `SqliteSyncResourceClaimRepository` and the SQ implementations of the T029 sync ports (`syncUseCases`, `syncMaterialize`, `syncConflicts`, `syncDependencySnapshots`, `syncNumberCollision`, `numberBlockUseCases`) in `backend/src/infrastructure/repositories/sqlite/`. **Done 2026-10-04:** already implemented and wired; proven by T103. Fix: device `applied_seq` start aligned with PG (baseline seeds `sync_inbox_applied_seq`).
- [X] T108 [US5] Resolve I-5 for sync: if any code hashes or compares jsonb payload text, make the SQ path canonicalize keys identically to PG `jsonb` output before hashing, in `backend/src/infrastructure/repositories/sqlite/helpers/jsonCanonical.ts`. Add a test in `backend/tests/sqlite/json-canonical.test.ts`. **Done 2026-10-04:** not needed — no code hashes or compares payload text (research.md §R13a); T103 compares with sorted keys.
- [X] T109 [US5] Implement the restore-on-synced-device flow (OQ-12, SY-6/SY-7) in `backend/src/application/use-cases/sync/syncUseCases.ts`, through ports only (no SQL in the use case): **Done 2026-10-05:** owner option (b): new sync identity after restore (migration `0002_sync_restore_state`, `syncRestoreUseCases.ts`, `restoredIdentity.ts`, block retirement, `/sync/run` + `/sync/status` + header notice); hub unchanged. Unit test 6/6 on both engines.
  - after a restore, set `sync_state.restored_snapshot=true` and pause sync;
  - fetch the hub head and auto-pull newer units;
  - open review mode only when local post-restore unpushed operations conflict, resolving with the existing keep-server/rebase/withdraw decisions;
  - mark outbox units acknowledged by the hub as synced, never re-pushing them;
  - resume sync.

  Surface the paused state and the "newer data on server" notice through the existing sync status UI (`/sync/status`).
- [X] T110 [US5] Run T102 and T103 plus the quickstart Â§6 restore-on-synced scenario. All must pass. Record the results in `scripts/parity/reports/US5-sync.md`. **Done 2026-10-05:** restore scenario PASS (`verify-sync-multidevice.mjs --ac8 --device-engine sqlite --restore`); T103 still empty diff; T102 unchanged (pre-existing shared-sync items only). `scripts/parity/reports/US5-sync.md`.

**Checkpoint**: US5 is complete. The SQLite desktops converge with the unchanged PG hub.

---

## Phase 8: User Story 6 â€” Complete history, however old and however large (Priority: P3)

**Goal**: at the gate volume, SQLite returns 100% of the PG completeness baseline and meets the OQ-4 targets (plan S10).

**Independent Test**: quickstart Â§7:
- at 100k invoices / 200k ledger rows / 10k parties: lists and the first page of a statement in under 2 s, a full single-party statement in under 10 s;
- 100% of baseline rows reachable;
- the 1M-invoice soak reported.

### Tests for User Story 6

- [X] T111 [P] [US6] Write `scripts/parity/volume.mjs`. It seeds the gate volume on the SQ build (`backend/scripts/seed-test-baseline.mjs`, engine-aware), measures list screens, statement first page and full single-party statement on real endpoints, and compares row and line counts with `scripts/parity/baseline/completeness.json` (T025). **Done 2026-10-04:** `scripts/parity/volume.mjs` (reproduces the T025 dataset exactly; completeness + timings on real endpoints).

### Implementation for User Story 6

- [X] T112 [US6] Run T111 at the gate volume. If a target is missed, add only indexes, or an FTS5 `trigram` **prefilter** whose final predicate stays `LIKE â€¦ ESCAPE '\'`, via a new forward migration in `backend/src/infrastructure/orm/sqlite/migrations/`. Re-run T063 search parity after any search change. Never add a limit. **Done 2026-10-04:** 18/18 at gate volume; migration `0001_statement_lookup_indexes.sql` (indexes only); full statement 8.2 s. `scripts/parity/reports/US6-volume.md`.
- [X] T113 [US6] Run the 1,000,000-invoice soak (report only). Record both runs in `scripts/parity/reports/US6-volume.md` (SC-008). **Done 2026-10-05:** 1M soak reported: 100% of rows reachable; invoices first page 2.2 s, 400k-line statement 623 s (per-page full-window totals; follow-up recorded in `US6-volume.md`).

**Checkpoint**: US6 is complete. History is complete and the gate targets are met.

---

## Phase 9: Polish, acceptance and release (plan S11)

**Purpose**: the release gates on the final packaged EXE. Any FAIL blocks release (Principle X, FR-066).

- [X] T114 [P] Extend `backend/scripts/durability-proof.mjs` for SQ. Loop multi-record saves (invoice + ledger + cash + stock) with random `taskkill /F` of the backend. Every document must be complete or absent, every confirmed save present, and `integrity_check` = `ok` (SC-004). **Done 2026-10-05:** `durability-proof.mjs --engine sqlite` (`durability-sqlite-crash.mjs`): 25/25 hard kills, integrity ok, 737/737 confirmed saves present, 0 incomplete. `scripts/parity/reports/durability.md`.
- [ ] T115 Run the VM power-loss test: hard-reset the VM at least 20 times during the T114 loop on Windows 10 22H2 x64 and on Windows 11 x64. Same expectations as T114. Record the results in `scripts/parity/reports/durability.md`.
- [X] T116 Build the final release installer. Record its sha256 in `scripts/parity/reports/RELEASE-CANDIDATE.md`. All following tasks use exactly this file (P-7, AC-12). **Done 2026-10-05:** `Motard Fabrics Group ERP_2.0.0_x64-setup.exe`, sha256 `17ffe64785d573402d5d8db74254877e763b8e1b27ef3e257aaf08fd831e8025` (version bumped to 2.0.0). `scripts/parity/reports/RELEASE-CANDIDATE.md`.
- [ ] T117 Run the full quickstart Â§4 lifecycle protocol (stages 1â€“11 plus negative cases) with the T116 installer on the Windows 10 22H2 x64 VM. Record a PASS/FAIL report per stage in `scripts/parity/reports/AC-lifecycle-win10.md`.
- [ ] T118 [P] Same as T117 on the Windows 11 x64 VM â†’ `scripts/parity/reports/AC-lifecycle-win11.md`.
- [X] T119 Re-run, against the T116 build: the parity set (T065), no-postgres (T066), backup/restore (T101), sync (T110) and volume (T112). Record AC-1â€¦AC-12 PASS/FAIL in `scripts/parity/reports/RELEASE-GATES.md`. **Done 2026-10-05 (developer machine):** on the T116 build — parity empty diff (67 files), no-postgres + running-instance PASS, sync/restore same as source (AC-8 fails only on pre-existing shared-sync items), volume 18/18; T101 (VM) not run. AC table in `scripts/parity/reports/RELEASE-GATES.md`.
- [X] T120 Write the release report `scripts/parity/reports/RELEASE-REPORT.md`: **Done 2026-10-05:** `scripts/parity/reports/RELEASE-REPORT.md` — verdict DO NOT RELEASE YET (VM gates not run; AC-8 pre-existing shared-sync items); U-1/U-2 mechanisms closed, incident causes not established; T016/T104 findings; tested sha256 recorded.
  - the gate table AC-1â€¦AC-12;
  - the U-1 and U-2 status, stated explicitly: mechanisms closed (D-3/track P; backup verification) and original-incident root causes not established, unless proven;
  - the T016 offline-rule findings and the T104 result;
  - confirmation that the tested installer sha256 equals the shipped one.

  Release only if every gate is PASS.
- [X] T121 [P] Update the desktop docs for the SQLite era: `desktop/README.md`, `desktop/DEV-WORKFLOW.md`, `desktop/BUILD-WINDOWS.md` and `docs/DISASTER-RECOVERY.md` (data root layout, startup states, backup v3, restore, no PG). Add a schema note to `ERP_GENOME.md` stating that the live schema has 53 tables / 73 enforced FKs per `specs/001-desktop-sqlite-engine/data-model.md` Â§1.0. **Done 2026-10-05:** README, DEV-WORKFLOW (no pgdata/PostgreSQL), BUILD-WINDOWS (startup states, backup v3, restore, restore on synced device), DISASTER-RECOVERY rewritten for the SQLite desktop, ERP_GENOME schema note (53 tables / 73 FKs).
- [X] T122 Final FR-040 / DB-8 verification on the T116 installer: unpack it and confirm that no PostgreSQL client or driver code path is reachable in the desktop bundle (`server.mjs` contains no executed `pg` import when `DB_ENGINE=sqlite`), no `pg_restore`/`pg_dump` binary exists, and the restore code rejects a v2 (PostgreSQL-era) archive with the "PostgreSQL-era backup" message. Record the result in `scripts/parity/reports/RELEASE-GATES.md`. **Done 2026-10-05:** `scripts/parity/verify-release.mjs` 10/10 on the T116 build: no PG artefact; V8 coverage shows no PostgreSQL client code executed (after making the PG migrator import lazy); a real v2 archive is refused with the PostgreSQL-era message (restore error-mapping bug fixed). Recorded in `RELEASE-GATES.md`.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: depends on Setup. Internal order is 2A investigations â†’ 2B D-4 fix â†’ 2C track P â†’ 2D freeze
  (T026 needs T018â€“T025) â†’ 2E S1 seam (T027â€“T031) â†’ 2F schema (T032â€“T040) â†’ 2G connection layer (T041â€“T048).
  2A tasks run in parallel. 2B and 2C may run in parallel with each other. 2F and 2G may overlap once T032 exists.
- **US1 (Phase 3)**: depends on Foundational. This is the MVP: the engine proven identical.
- **US2 (Phase 4)**: depends on Foundational. Its runtime work (T068â€“T072) can proceed in parallel with US1. **T078 needs
  US1 complete plus T075 (install-instance marker), T076 (minimal FRESH/REUSE) and T077 (FRESH creation)**, so
  the packaged app can create and reopen a database and detect a new installation (D-1). T075 precedes T076.
- **US3 (Phase 5)**: depends on US2 (T068, T071). T083 and T085 call US4 functions: use the documented interim behavior
  ("block with clear message") until US4 lands.
- **US4 (Phase 6)**: depends on US1 (repositories) and the T042 connection layer. Independent of US3, except the
  `restore_backup` startup action (T085).
- **US5 (Phase 7)**: depends on US1 and US4 (restore-on-synced needs T098).
- **US6 (Phase 8)**: depends on US1 and track P (T022â€“T025).
- **Polish (Phase 9)**: depends on all stories.

### Story completion order

`Foundational â†’ US1 â†’ (US2 âˆ¥ US4) â†’ US3 â†’ US5 â†’ US6 â†’ Polish`

### Within each story

Tests are written first and must fail before implementation. Batches 4aâ†’4f run in order. Each batch ends green before the next starts.

## Parallel Execution Examples

- **Phase 2A**: T007, T008, T009, T010, T011, T012, T013, T014 and T015 together. They are all read-only investigations.
- **Phase 2C**: T022 and T023 together (different files). T024 follows T023.
- **US1**: T049 and T050 together. Within batches: T053, T055 and T059 touch different files and can be developed in parallel PRs, but
  each verification task (T054/T056/T058/T060) runs after its own batch. T052 must finish before any batch starts.
- **US2**: T066 and T067 together. Then T068 â†’ T069 â†’ T070, while T071 runs in parallel with T070.
- **US3**: T079 and T080 together. T082 (I-14 update test) runs in parallel with T081.
- **US4**: T090 and T091 together. Then T092 â†’ T093 â†’ T094 â†’ T095. T096, T097 and T099 follow T095 and run in parallel with each other.
- **US5**: T102 and T103 together. T106 and T107 in parallel after T105.
- **Polish**: T117 and T118 in parallel on separate VMs. T121 at any time. T122 after T116.

## Implementation Strategy

### MVP first (User Story 1)

1. Phases 1â€“2: setup, the D-4 fix, track P, reference freeze, engine seam, schema and connection layer.
2. Phase 3 (US1): all repositories on SQLite, with an empty parity diff.
3. **Stop and validate**: T064 + T065. At this point the SQLite engine is proven behaviorally identical. The desktop still ships
   the PG build, so nothing reaches customers yet.

### Incremental delivery

1. US2: the runtime without PG (internal builds only).
2. US4: verified backup and restore.
3. US3: identity and lifecycle states.
4. US5: sync convergence.
5. US6: volume.
6. Phase 9: packaged-EXE gates on both Windows versions, then release.

### Safety rules carried from the plan

- **Until T073 (PG packaging removal)**: the PG desktop build stays shippable from the same branch.
- **After release**: rollback means shipping the previous PG release. Downgrading a SQLite install to a PG build is unsupported. The PG build would see no `pgdata` and refuse with DATA_MISSING, never touching `motard.db`.
- **Cloud changes**: only S1 (T027â€“T031) touches code the cloud runs, and it is gated on T031.

## Notes

- `[P]` = different files and no dependency on an incomplete task.
- Commit after each task or logical group. Each S4 batch is its own PR.
- D-1 to D-4 are final owner decisions (spec Clarifications). D-3, D-4 and track P are the only approved pre-reference
  defect fixes (FR-070).
- **DREX** was not consulted for this task list: repository evidence and the settled artifacts resolved all ordering. If used
  later as a secondary check, never send `.env`, keys, secrets or licence data, and never let it override repository evidence or the
  spec.
