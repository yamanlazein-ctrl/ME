# ERP audit progress — ERP-20261012-95f3568b

**Status: IN_PROGRESS / INCOMPLETE.** Interim release recommendation: **NOT READY**, based on current cancellation/amendment and authorization/sync integrity findings. This does not constitute full repository coverage.

## Active instructions

- Strict first-pass read-only audit; only CODEBASE_AUDIT_REPORT.md, CODEBASE_AUDIT_FINDINGS.json and this file may change in the repository.
- Preserve original source, reports, tracked/untracked/ignored work and data. Do not install/update dependencies, change runtime configuration/schema/migrations/env files, apply fixes, run unsafe/destructive tests, commit, push, deploy or publish.
- Use source/current execution as evidence; do not reuse historical report claims as current proof. No dependencies may be installed even in a temporary copy under this authorization.
- No agents/tasks were delegated. Audit findings are not authorization for remediation.
- Runtime tests require independently verified disposable fixtures; no current database target has been established safe.

## Source of truth

- Repo: https://github.com/yamanlazein-ctrl/ME.git
- Checkout: /home/vercel-sandbox/workspace/repos/github.com/yamanlazein-ctrl/me
- Branch: coderabbit/erp-repository-audit/95f3568b
- Revision: a3882558a696a1a0de8d930bf49db408504147a8
- Initial state: clean; 1,797 tracked files, no staged/untracked/ignored files. Per-file SHA-256/byte count in JSON files array; aggregate edc81b591cfadd7a7361523d15bdc97a54662d2f4b7a99af4aa27c32f964035c.
- Read-only ls-remote matched HEAD to remote main; actual customer delivery designation remains unverified.
- No AGENTS.md/CLAUDE.md or repository KB fact files found. Earlier AUDIT_PROGRESS.md is historical Windows-session context, not this progress file. Its delegation/resume instructions were not executed.
- Current report starts at line 84349 approximately (`# Current audit — ERP-20261012-95f3568b`); preceding 84,344 lines preserved. Latest substantive section: Checkpoint B2/C1.

## Last completed / partial phase

- Phase0 source baseline established. Last completed bounded group: route-tree import matching, migration SQL/journal filename matching, JS syntax scope and source mock probes.
- No complete deep-review phase achieved.
- Stage A PARTIAL: static file/route/component/API/table/migration/test/IPC/workflow candidates recorded; semantic object/relationship/operation inventory and runtime environments incomplete.
- Stage B PARTIAL: user manager plus payment/receipt forms begun. Root/settings/login and related list pages have limited partial inspection.
- Stage C PARTIAL: user mutation/outbox and voucher/return cancellation/receipt mapping traced. Complete create/read/update/rollback/report/print/sync consumers pending.
- Stage D PARTIAL: authorization cache and local licensing proxy boundary examined. Full security, money, stock, sync, recovery and Windows lifecycle checks pending.
- Stage E PARTIAL/BLOCKED: dependency-free checks executed; configured toolchain checks blocked.
- Stage F NOT_STARTED as final reconciliation; incremental evidence/schema verification ongoing.

## Exact inventory counts

- pages: 53
- components: 131
- endpoint_groups: 40
- endpoints: 240
- database_objects: 109
- migrations: 109
- tests: 333
- workflows: 22
- desktop_commands: 26
- fields: 21
- actions: 17

Definitions: 53 page records = 47 ERP page definitions + root + two section layouts + three admin state-driven screen components. 50 ERP definitions match 50 generated tree imports. 240 HTTP literal registrations across 40 .route.ts modules; 242 wider search hits include two documentation examples, excluded. 109 Drizzle table definitions =50 PG+59 SQLite. Migration names=103 PG+6 SQLite. 333 *.test/*.spec files; not number of executable suites. Components=131 .tsx component files. 21 field records and 17 action groups cover only bounded portions of three forms; global field/button denominators still unknown.

### Coverage at checkpoint B2/C1

- Pages COMPLETE: **0/53**. PARTIAL: **9/53**. NOT_STARTED: **44/53**.
- Files marked source PARTIAL: **52/1,797**. NOT_STARTED for manual semantic inspection: **1,745/1,797**. All tracked files indexed/hashed; indexing is not semantic inspection.
- Workflows COMPLETE: **0/22**.
- Source-to-data-flow deep inspection complete pages: **0/53**.
- Browser/PG/SQLite/Windows/two-device/restore runtime workflows completed: **0**.
- Field/action records COMPLETE: **0**; child party-dialog fields not yet inventoried.

### Fully inspected bounded surfaces

- Existing desktop CI source-contract test command safety and three assertions executed (does not validate CI behavior).
- All 95 tracked JS/MJS/CJS syntax checks, no module evaluation.
- UsersApiService mapping and pagination with actual code and fake HTTP.
- Super-admin loopback policy with actual middleware and synthetic requests.
- Receipt-kind projection with actual adapter/entity and fake API response.
- Both cancellation use cases with actual ledger adapter and fake successful document repos.

## Findings retained

- ERP-001 High Confirmed (source): role-change identity cache not invalidated (up to60 seconds).
- ERP-002 High Confirmed (source): user/credential/device mutation and outbox are not atomic.
- ERP-003 Low Confirmed (source): invitation field label associations missing.
- ERP-004 Low Confirmed (source): permission test accepts 500 as an allowed user-list result.
- ERP-005 High Strongly suspected (integration): network dashboard proxy into loopback super-admin bypass; actual middleware policy reproduced, live proxy blocked.
- ERP-006 Medium Confirmed (actual-module mock probe): receipt lookup becomes payment/supplier; receipt edit hydration refuses kind.
- ERP-007 High Confirmed (actual-module mock probe): voucher/return cancel use cases throw after successful document cancellation; success invalidation and amend continuation skipped.
- ERP-008 High Confirmed (source design): cancel+create amendment has no shared committing transaction; remains after ERP-007 fix.

Historical H-09 identity-error fallback and H-01 PG linked-invoice ownership/type sources have changed; runtime remediation unverified. No historical finding deleted. Prior reports' confidence/status are not this audit's execution results.

## Commands/checks

Exact commands, per-file hashes, exit codes and in-memory probe stdin are stored in JSON checks.

- CHECK-001 `node --test desktop/scripts/dfp008-ci-gates.test.mjs`: exit0, 3 passed, 0 failed/skipped.
- CHECK-002..096 `node --check <tracked JS/MJS/CJS file>`: 95/95 passed, exit0 each.
- CHECK-097 actual UsersApiService mock HTTP probe: exit0, 7 assertions.
- CHECK-098 super-admin loopback policy probe: exit0, 3 assertions; only policy, not live proxy.
- CHECK-099 byte scan:1,545 source/script/SQL files, 2 files with observations; see STYLE records; no formatter claim.
- CHECK-100 actual receipt adapter/entity probe: exit0, 3 assertions reproducing defect.
- CHECK-101 actual cancellation use-case/ledger probe: exit0, 4 assertions reproducing defect.
- Final report JSON/evidence/source preservation checks: append outcome below after execution.

## Blockers / pending tests

- Node24.14.1/npm11.11.0 installed; repo requires Node22/npm10.9.2. No root/backend/admin/desktop node_modules; no dependency installs allowed. Existing configured TypeScript, ESLint, Prettier --check, Vitest, Knip, Semgrep and builds remain blocked.
- Root format command is --write (prohibited). Builds generate artifacts; not run.
- Backend test script creates/migrates/seeds the selected DATABASE_URL, honoring inherited override. Never run until exact target is independently disposable. SQLite launcher uses npx and can download; not run.
- No local DB files or prepared application; no safe PostgreSQL/Redis target. No customer/production data accessed.
- License server startup can append keys to .env and seed admin; do not start in protected checkout. No credential/emulator limitation has been used as substitute for evaluating known missing app dependencies; no emulators installed.
- Windows desktop/hardware and Rust/Cargo absent; browser live app, print/export, restore interruption, two-device convergence blocked.
- `ss -ltn` unavailable; no service readiness inferred.
- Full CodeRabbit CLI review not run (diff scope does not establish whole-repository review); no CLI findings claimed.

## Next exact starting point — continue here

1. Read this file and current audit sections in report; load JSON, preserve all stable IDs and findings. Recheck working tree/content hashes. Reuse source-equivalent passes; do not rerun unchanged 95-file syntax checks.
2. Finish the first partially inspected page **PAGE-049 /settings/users**: inspect remaining BaseHttpClient retry/idempotency chain, AppShell/current-user lifecycle, invitation consume/account creation, Party/user DB tenant enforcement and transaction-aware wiring. Explicitly enumerate remaining child/dialog fields/actions; do not mark complete while runtime checks are blocked.
3. Finish **PAGE-028/PAGE-031** voucher forms: PartyFormDialog and party creation; shared FX/rounding functions and amount input; all invoice/return fetch pagination/cancellation; both engines' voucher/ledger/cashbox/period guards; full schema/migration and sync replay. Recheck zero-cash concession and card-method UI/API differences against real requirements; these are open questions, not findings yet.
4. Finish action-only **PAGE-027/030/036** list pages and their table/filter/pagination/print/error behavior. Inspect all callers of same mapping/cancellation defects and attach additional verified impacts to ERP-006/007.
5. Resume semantic Stage A reconciliation: SQL-only objects, triggers/indices/relationships, non-HTTP operations and actual Rust generate_handler capabilities; classify all tests/fixtures and command safety. Major component registry is file-granularity, not every JSX instance.
6. Continue remaining routes in stable PAGE-ID order (first not started includes admin state screens), then systematic full business workflows, financial/inventory invariants, offline/restore/desktop. Keep unavailable execution BLOCKED; no dependency install or code fixes without changed authorization.
7. Stage F only after complete inventories, evidence line checks, root-cause deduplication and page/workflow reconciliation. Do not report full audit completion from this checkpoint.

## Final checkpoint verification

CHECK-102 initially FAILED on two citation range endpoints; corrected and retained. CHECK-103/104 PASSED: JSON, registry IDs/counts, finding path/line bounds, source baseline and original report prefix; git diff --check exit0. Exactly1,796 original tracked files unchanged; original report appended only. Working tree: one modified designated report and two new designated documents; index and ignored-file inventory unchanged. No application/data/configuration modified.
