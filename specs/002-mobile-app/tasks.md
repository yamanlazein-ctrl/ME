---
description: "Executable task list for Motard ERP Mobile (Android v1)"
---

# Tasks: Motard ERP Mobile (Android v1)

**Input**: `specs/002-mobile-app/` — spec.md (clarified), plan.md, research.md (R1–R15), data-model.md,
contracts/hub-api.md, contracts/backend-changes.md, contracts/mobile-ports.md, quickstart.md.
Constitution: `.specify/memory/constitution.md` v2.0.0. Branch: `feat/mobile`.

**Executor**: a cold cloud agent (Claude Sonnet 5.5) with only this repository. It has no chat history, no
phone and no access to the owner's notes. Everything it needs is in this file and the documents above.

## Read first (rules for every task)

1. Before starting, read `specs/002-mobile-app/plan.md`, `research.md`, the three files in `contracts/`, and
   `.specify/memory/constitution.md`. Re-read the contract a task names before doing that task.
2. Work on branch `feat/mobile`. Never commit to `main`. Never `git stash`, `git reset --hard` or force-push.
3. Never edit or move a desktop file except the ones a task names (constitution V; Clarification Q1).
4. Money: never round with `Math.round(x * 100) / 100`; use `round2dp` / `round4dp` from
   `packages/shared/src/precision.ts`. USD and SYP are never summed (constitution I).
5. No secrets in files: database URLs, passwords and keys come from environment variables.
6. No `eslint-disable` comments, no `any` without a one-line reason comment, TypeScript strict.
7. A task is done only when its "Check" command passes. Paste the command's summary line into
   `specs/002-mobile-app/evidence/<TaskID>.md`. If the check fails and cannot be fixed within the task,
   mark the task `- [!]`, write the failure into its evidence file, and continue with the next task
   that does not depend on it.
8. Tasks marked **OWNER-LOCAL** need the owner's phone. The agent SKIPS them (leaves `- [ ]`), never
   fakes their result, and continues. Tasks marked **CONDITIONAL** run only when the named owner
   result says FAIL; otherwise skip them.
9. Tick `- [x]` in this file when a task's check passes, in the same commit as the work.
10. Never use `vitest --reporter=basic`; read the summary line ("Tests N passed").
11. Traceability: a task without its own requirement IDs inherits the IDs and research items named in
    its phase heading.
12. Do not build these (out of v1 by decision): BC-6 (`packages/core` extraction), a fix for the
    known gap E17 (hub web-UI writes are not in the pull stream), the dark theme, iOS builds.

## Standard checks (referenced by name)

**GATE-M (mobile)**: run from the repository root:
`cd mobile && npx tsc --noEmit && npx eslint . --max-warnings 0 && npx vitest run && cd .. && npx prettier --check mobile specs/002-mobile-app`.
Pass = every command exits 0.

**GATE-D (desktop safety, constitution V)**: run one suite at a time, in this order. Compare the
failure counts with `specs/002-mobile-app/evidence/baseline.md` (written by T003):

1. `cd backend && npx tsc --noEmit`
2. `cd backend && npm run typecheck:sqlite`
3. `cd backend && npm run lint`
4. `cd backend && DB_ENGINE=sqlite npx vitest run --maxWorkers=2`
5. `cd backend && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/erp_test npx vitest run --maxWorkers=2`
6. `npx vitest run`
7. `npm run lint`

Pass = for each command, the failures are no more than the baseline's and every new test passes. If
GATE-D fails, STOP: revert the uncommitted backend/shared change with `git checkout -- <files>`, mark the
task `- [!]`, and do not continue to tasks that depend on it.

**GATE-P (sync parity)**: needs PostgreSQL (T002). Run
`cd mobile && CERT_PG_URL=postgresql://postgres:postgres@localhost:5432/postgres npx vitest run test/parity`.
Pass = every scenario reports 0 field differences across phone, desktop and hub.

**CHECKPOINT**: run from the repository root:

1. `git add -A`
2. `git commit -m "<message given in the checkpoint>"` with the trailer
   `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
3. `git push origin HEAD:feat/mobile`

If the push is refused, run `git pull --no-rebase origin feat/mobile`, resolve nothing by guessing (stop
and report if conflicts appear), then push again.

## Format

`- [ ] T### [P] [US#] Description` — [P] means it may run in parallel with the other [P] tasks of the same
group (different files, no dependency between them). IDs in brackets after the title (FR-xx, NFR-xx,
E#, BC-#, UX-##, SC-###) trace to spec.md.

---

# TIER A — must finish with the $100 credit

## Phase 1: Environment and desktop baseline

**Purpose**: a working Linux test environment and the numbers GATE-D compares against.

- [ ] T001 (constitution V, IX) Install dependencies: run `npm ci` at the repository root and `cd backend && npm ci`.
      Check: both exit 0, and `node --version` prints v22 or later. If it prints an older version, install
      Node 22 with `nvm install 22` and retry.
- [ ] T002 (constitution V) Provision PostgreSQL for tests the way `.github/workflows/ci.yml` does.
  - If `docker` exists: `docker compose -f backend/docker-compose.yml up -d postgres redis` with
    `POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres POSTGRES_DB=postgres
APP_MASTER_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=`, then
    `docker exec erp-postgres psql -U postgres -c "CREATE DATABASE erp_test TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C';"`.
  - Else: `sudo apt-get install -y postgresql`, `sudo service postgresql start`, set the postgres
    password to `postgres`, and create `erp_test` with the same `LC_COLLATE 'C' LC_CTYPE 'C'` statement.
  - Then: `cd backend && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/erp_test npm run db:migrate`.

  Check: `psql postgresql://postgres:postgres@localhost:5432/erp_test -c "select 1"` prints 1.

- [ ] T003 Record the desktop baseline. Run the 7 GATE-D commands once, before any change, with
      `E2E_ADMIN_PASSWORD=CiTestAdmin!Pass9 ALLOW_TEST_SEED=1 NODE_ENV=test` exported for steps 4–5. Write
      each command's summary line (passed / failed / skipped counts) to
      `specs/002-mobile-app/evidence/baseline.md`.
      Check: the file has 7 entries. Failing tests are allowed here; they are recorded, not fixed.
- [ ] T004 CHECKPOINT "chore(mobile): test environment notes and desktop baseline".

## Phase 2: Money vectors (before any mobile money code) [constitution IV, SC-001, NFR-05]

- [ ] T005 Create `packages/shared/src/money-vectors.json`, a JSON array of cases
      `{ "id": string, "op": "round2dp"|"round4dp"|"lineValue"|"invoiceTotal"|"usdToSyp"|"sypToUsd", "input": object, "expected": number|string }`.
  - Seed it from the assertions in:
    - `packages/shared/src/precision.test.ts`
    - `backend/tests/money-precision.test.ts`
    - `src/shared/utils/__tests__/precision.test.ts`
    - `backend/tests/invoice-total-parity.test.ts`
  - Add these edge cases:
    - halves at .005 and .00005, both signs
    - negative zero (it must not round to −0)
    - 9007199254740993 written as a string
    - rates with 4 decimals
    - a line where the discount exceeds qty×price (expected 0)
  - Formulas:
    - lineValue = `max(0, round2dp(qty × price − discountAmount))`
    - invoiceTotal = `round2dp(subtotal − discount + tax + shipping)`
    - usdToSyp multiplies by the rate; sypToUsd divides by it

  At least 120 cases. Check: `node -e "JSON.parse(require('fs').readFileSync('packages/shared/src/money-vectors.json','utf8')).length"` prints ≥ 120.

- [ ] T006 Create the Node runner `packages/shared/src/money-vectors.test.ts` (Vitest). It loads the JSON
      and asserts each case through the real `round2dp` / `round4dp` and the line/total formulas built from
      them. Check: `npx vitest run packages/shared/src/money-vectors.test.ts` → all passed, 0 failed.
- [ ] T007 Run GATE-D steps 6 and 7 (shared code changed). Check: GATE-D rule.
- [ ] T008 CHECKPOINT "test(shared): cross-runtime money vectors (constitution IV)".

## Phase 3: Backend changes BC-2, BC-3, BC-1 [contracts/backend-changes.md]

- [ ] T009 S4 proof first: create `backend/tests/sync-version-gate.test.ts` with three cases against
      `/api/sync/push` and `/api/sync/pull`: matching `X-Motard-Money-Version` → 200; a different value →
      426 with `code: "SYNC_VERSION_MISMATCH"`; header absent → 200. Copy the app setup used by an existing
      sync route test (`backend/tests/sync-behavioral-idempotency.test.ts`). Run it before T010.
      Check: `cd backend && npx vitest run tests/sync-version-gate.test.ts` shows the "different value →
      426" case FAILING (this proves the gate is absent, research R6). Record that in evidence.
- [ ] T010 Add `export const MONEY_RULES_VERSION = 1;` to `packages/shared/src/precision.ts` and export it
      from `packages/shared/src/index.ts` if precision exports are re-exported there.
      Check: `npx tsc --noEmit` exit 0.
- [ ] T011 Create `backend/src/infrastructure/http/middleware/syncVersionGuard.middleware.ts`, exporting
      `syncVersionGuard: RequestHandler`.
  - The header is present and `Number(header) !== MONEY_RULES_VERSION` → respond
    `426 { code: "SYNC_VERSION_MISMATCH", message: "تحديث مطلوب", hubVersion, clientVersion }`.
  - The header is absent → `next()`. Owner decision 2026-10-25: delivered desktops keep syncing until
    every desktop sends the header.
  - The header is not an integer → the same 426.

  Check: `cd backend && npx tsc --noEmit` exit 0.

- [ ] T012 Wire the guard:
  - add `syncVersionGuard: RequestHandler` to the guards type in
    `backend/src/presentation/routes/sync.route.ts` (around line 178)
  - add it after `guards.transportGuard` on `/sync/push` (around line 1165) and on `/sync/pull`
  - pass it in the guards object in `backend/src/presentation/server.ts` (around line 547)

  BC-2, FR-38. Check: `cd backend && npx vitest run tests/sync-version-gate.test.ts` → 3 passed, on
  both `DB_ENGINE=sqlite` and PostgreSQL.

- [ ] T013 BC-3 verification: create `backend/tests/sync-revoked-device-codes.test.ts`. Register a device,
      revoke it with `POST /api/sync/devices/:deviceId/revoke` as admin, then assert
      `403 code SYNC_DEVICE_REVOKED` on `/api/sync/push`, on `/api/sync/pull` and on
      `POST /api/sync/device-token`. FR-40.
      Check: the test passes on both engines. If a path does not return that code, fix only that path's route
      file (`sync.route.ts` or `syncEnrollment.route.ts`) and record the change in evidence.
- [ ] T014 BC-1: in `backend/src/application/use-cases/sync/numberBlockUseCases.ts`, add an optional
      `deviceKind?: "desktop" | "phone"` to the block-ensure input. When it is `"phone"`:
  - the size is 100 for `invoice` and 50 for every other entity type
  - the refill threshold at line 135 (`Math.ceil(size * 0.25)`) uses that size
  - line 163 claims that size

  When the input is absent, the behavior is unchanged. Do not change `defaultBlockSize` in either twin
  (`backend/src/infrastructure/repositories/sqlite/helpers/documentNumbers.ts` line 245,
  `backend/src/infrastructure/utils/documentNumbers.ts` line 244). FR-35.
  Check: `cd backend && npx tsc --noEmit` exit 0.

- [ ] T015 Create `backend/tests/number-blocks-phone-size.test.ts`, asserting:
  - phone invoice block = 100
  - phone voucher block = 50
  - the phone refill triggers at 25 remaining invoices
  - a desktop invoice block is still 500 and a desktop voucher block is still 200

  Check: passes on both engines.

- [ ] T016 Run GATE-D in full. Check: GATE-D rule. On FAIL, stop here (constitution V).
- [ ] T017 CHECKPOINT "feat(sync): money-version gate, phone block sizes, revoked-code test (BC-1, BC-2, BC-3)".

## Phase 4: Mobile project skeleton and import boundary [R1, contracts/mobile-ports.md]

- [ ] T018 Create the Expo app: run `npx create-expo-app@latest mobile --template blank-typescript --no-install`.
  - In `mobile/package.json` replace every `^`/`~` range with the exact installed version.
  - Add `"drizzle-orm": "0.45.2"`, the same version as `backend/package.json`.
  - Add Expo Router per its install guide (`npx expo install expo-router react-native-safe-area-context react-native-screens expo-linking expo-constants expo-status-bar`).
  - Run `cd mobile && npm install`.

  Check: `cd mobile && npx expo --version` prints a version; `npx tsc --noEmit` exit 0. Record the Expo
  SDK version in `specs/002-mobile-app/evidence/T018.md`.

- [ ] T019 Configure the app:
  - `mobile/app.json`:
    - `name` "Motard ERP"
    - `slug` "motard-erp-mobile"
    - `android.package` "com.motard.erp"
    - `scheme` "motard"
    - `userInterfaceStyle` "light"
    - `android.softwareKeyboardLayoutMode` "resize"
    - `experiments.typedRoutes` true
    - `plugins`: `"expo-router"`, `["expo-localization", { "supportsRTL": true, "forcesRTL": true }]`,
      `["expo-build-properties", { "android": { "minSdkVersion": 26 } }]` (NFR-07: Android 8.0+)
    - install the two plugins first: `npx expo install expo-localization expo-build-properties`
  - `mobile/tsconfig.json`: extends `expo/tsconfig.base`, with `"strict": true`, `"noUncheckedIndexedAccess": true`,
    and `paths` `"@backend/*": ["../backend/src/*"]`, `"@erp/shared": ["../packages/shared/src/index.ts"]`,
    `"@erp/shared/*": ["../packages/shared/src/*"]`.

  UX-04, NFR-07, NFR-10. Check: `cd mobile && npx tsc --noEmit` exit 0, and `grep -c minSdkVersion mobile/app.json` prints 1.

- [ ] T020 Create `mobile/metro.config.js` from `expo/metro-config`:
  - `watchFolders`: `../backend/src`, `../packages/shared/src`
  - `resolver.extraNodeModules`: `@erp/shared` → `../packages/shared/src`
  - `resolver.resolveRequest`:
    - map `node:async_hooks` → `mobile/src/platform/asyncContext.ts`
    - map `node:crypto` → `mobile/src/platform/nodeCrypto.ts`
    - map `better-sqlite3` → `mobile/src/platform/sqlite/BetterSqliteShim.ts`
    - map the resolved file `backend/src/infrastructure/config/logger.ts` (imported as
      `../config/logger.js` and similar relative paths) → `mobile/src/platform/logger.ts`
    - map the resolved file `backend/src/infrastructure/config/env.ts` (imported as `../config/env.js`)
      → `mobile/src/platform/envConfig.ts`. 18 shared files import one of these two (checked
      2026-10-25); both real files use `node:path`, `node:url`, `pino` or `dotenv`.
    - throw `Error("mobile import boundary: <name>")` for `node:fs`, `node:path`, `node:os`, `node:net`,
      `node:url`, `fs`, `path`, `os`, `net`, `child_process`, `http`, `https`, `express`, `pg`,
      `argon2`, `googleapis`, `pino`, and any module starting with `@sentry/`

  Create empty placeholder modules for the five mapped files exporting nothing yet.
  Check: `cd mobile && node -e "require('./metro.config.js')"` exit 0.

- [ ] T021 Create `mobile/eslint.config.js` (flat config, typescript-eslint). Its `no-restricted-imports`
      `paths` and `patterns` ban the same list as T020, with a message pointing to contracts/mobile-ports.md.
      Add `"lint": "eslint . --max-warnings 0"`, `"typecheck": "tsc --noEmit"`, `"test": "vitest run"` to
      `mobile/package.json`. Check: `cd mobile && npm run lint` exit 0.
- [ ] T022 Create `mobile/test/unit/boundary.test.ts` (Vitest). It programmatically lints a temp file
      containing `import fs from "node:fs";` with the mobile ESLint config, asserts 1 error, and asserts
      that calling the T020 `resolveRequest` with `"pg"` throws.
      Add `mobile/vitest.config.ts` (environment node, aliases matching tsconfig paths).
      Check: `cd mobile && npx vitest run test/unit/boundary.test.ts` → passed.
- [ ] T023 [P] Implement `mobile/src/platform/nodeCrypto.ts` per contracts/mobile-ports.md: `randomUUID`,
      `createHash("sha256")` with `update` and `digest("hex"|"base64")`, `randomBytes`, and constant-time
      `timingSafeEqual`. Also export `setUuidSequenceForSpike(prefix: string)`: after it is called,
      `randomUUID` returns deterministic v4-shaped ids derived from the prefix and a counter. It is used
      only by the S2 spike (T050). Use `expo-crypto` on device. Behind the same functions, use the Web Crypto
      `globalThis.crypto` path when running under Node tests. Add
      `mobile/test/unit/nodeCrypto.test.ts`, comparing the sha256 of "motard" and of the empty string with
      Node's `crypto`, and checking the UUID v4 format.
      Check: that test file passes.
- [ ] T024 [P] Implement `mobile/src/platform/asyncContext.ts` (class `AsyncLocalStorage` with `run`,
      `getStore` and `enterWith`, using a module-level stack) and `mobile/src/core/serialExecutor.ts`
      (`runSerial<T>(fn: () => Promise<T>): Promise<T>`, a FIFO queue, one job at a time). Research R3.
      Add `mobile/test/unit/serialExecutor.test.ts`:
  - two jobs started together never interleave (assert ordered markers)
  - `getStore()` inside nested `run` calls returns the innermost store and restores the outer one
  - a rejected job does not block the next

  Check: passes.

- [ ] T025 Define the shim interface `mobile/src/platform/sqlite/types.ts`: the better-sqlite3 subset
      listed in contracts/mobile-ports.md (`prepare` → `run/get/all/iterate/raw/safeIntegers`, `pragma`,
      `exec`, `function`, `aggregate`, `transaction`, `close`). Check: `cd mobile && npx tsc --noEmit` exit 0.
- [ ] T026 Create `mobile/scripts/bundle-migrations.mjs`. It reads every `.sql` file listed in
      `backend/src/infrastructure/orm/sqlite/migrations/meta/_journal.json`, in journal order, and writes
      `mobile/src/core/generated/migrations.ts`, exporting `MIGRATIONS: { tag: string; sql: string }[]` and
      the journal index. Add `"prebuild:migrations": "node scripts/bundle-migrations.mjs"` to
      `mobile/package.json`. Add `mobile/test/unit/migrations-bundle.test.ts`, asserting that the count and
      tags equal the journal. Check: passes.
- [ ] T027 Implement `mobile/src/core/runtime.ts`: `openRuntime(conn: ShimDatabase)`.
  - It asserts the pragmas `connection.ts` asserts (WAL, foreign_keys ON, synchronous not OFF).
  - It applies the `MIGRATIONS` not yet applied, using the same bookkeeping
    `backend/src/infrastructure/orm/sqlite/runtime.ts` uses, without importing that file (it uses fs).
  - It registers the five `motard_*` functions by calling the exported registration function from
    `backend/src/infrastructure/orm/sqlite/numericFunctions.ts` on the shim.
  - It refuses to open when the stored journal index is newer than the bundled one.
  - It exports `ensureMeta(conn, { tenantId, installationId })`, which creates the single
    `motard_meta` row (`id = 1`) when absent, with the same column values
    `backend/src/infrastructure/orm/sqlite/runtime.ts` writes for a new database (read that file;
    `created_by_installation_id` = the phone's installation id, `tenant_id` = the enrolled tenant).

  NFR-06, FR-01. Check: `cd mobile && npx tsc --noEmit` exit 0.

- [ ] T028 Create `mobile/test/unit/runtime-node.test.ts`. Under Node, open a temp file with the real
      `better-sqlite3` (from `backend/node_modules`; tests only, through a test helper
      `mobile/test/helpers/nodeSqlite.ts` excluded from the app bundle by path). Run `openRuntime`, then
      compute the schema fingerprint with the same function `backend/src/infrastructure/orm/sqlite/schemaFingerprint.ts`
      exports, and compare it to `backend/src/infrastructure/orm/sqlite/migrations/meta/schema-fingerprint.json`.
      Also run the cases of `backend/tests/sqlite/pg-numeric-div.test.ts` against `motard_pgdiv` through the
      shim. Also assert atomicity: a use-case transaction that throws after inserting an invoice header leaves 0 rows in `invoices`, `invoice_lines` and `ledger_entries` (E6, NFR-06). Check: passes. This proves R2 criteria 2 and 4 on Node; the device run is T041.
- [ ] T029 Run GATE-M. Check: GATE-M rule.
- [ ] T030 CHECKPOINT "feat(mobile): Expo skeleton, import boundary, platform adapters, runtime".

## Phase 5: Device build pipeline and M0 spike code [R2, R3, R8, R9, R14, R15]

- [ ] T031 Create `.github/workflows/mobile-android.yml` (name `mobile-android`).
  - Triggers: `workflow_dispatch`, and `push` on branch `feat/mobile` with paths `mobile/**`,
    `backend/src/**`, `packages/shared/src/**`.
  - Job `checks` (ubuntu-latest, Node 22): `npm ci` at root, `cd backend && npm ci`,
    `cd mobile && npm ci`, then GATE-M's commands.
  - Job `apk` (needs `checks`, ubuntu-latest): Node 22, `actions/setup-java` Temurin 17,
    `cd mobile && npm ci && npm run prebuild:migrations && npx expo prebuild --platform android --no-install`,
    `cd mobile/android && ./gradlew assembleRelease` with the env `EXPO_PUBLIC_SPIKES=1`. The release
    variant bundles the JavaScript inside the APK (a debug APK would need a Metro server on the
    computer, which the owner does not have). The Expo template signs the release variant with its
    debug keystore, which is acceptable for test installs. Then `actions/upload-artifact` named
    `motard-mobile-test-apk` with `mobile/android/app/build/outputs/apk/release/*.apk`, retention 14
    days.

  R15. Check: `npx prettier --check .github/workflows/mobile-android.yml` exit 0, and
  `node -e "require('yaml')"` parse of the file succeeds (install `yaml` temporarily with `npx -y`).

- [ ] T032 Add the native modules:
  - `npx expo install expo-secure-store expo-local-authentication expo-print expo-sharing expo-notifications expo-background-task expo-crypto expo-file-system expo-camera expo-splash-screen expo-font @react-native-community/netinfo`
  - `npm install --save-dev @testing-library/react-native` (exact version)
  - `npm install @op-engineering/op-sqlite react-native-argon2` (exact versions)
  - in `mobile/package.json` add `"op-sqlite": { "sqlcipher": true }`, per op-sqlite's SQLCipher
    documentation

  Pin all versions. Check: `cd mobile && npx tsc --noEmit` exit 0 and
  `npx expo prebuild --platform android --no-install` exit 0 (Linux has no SDK need for prebuild).

- [ ] T033 Implement `mobile/src/platform/sqlite/BetterSqliteShim.ts` over op-sqlite (R2):
  - `open({ name: "motard.db", encryptionKey })`
  - synchronous `prepare().run/get/all` via `executeSync`
  - `pragma`, `exec`, and `transaction(fn)` with `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`
  - `function` and `aggregate`: implement through op-sqlite's function registration if its API has
    one. If not, throw `Error("UDF_UNSUPPORTED")`, so S1 reports FAIL and CONDITIONAL T044 applies.
  - safe integers: return `bigint` outside ±2^53

  Check: `cd mobile && npx tsc --noEmit` exit 0 (device behavior is proven by T041).

- [ ] T034 Implement `mobile/src/platform/secureStore.ts` (`getSecret`, `setSecret`, `deleteSecret`, and
      `getOrCreateDbKey()` creating 32 random bytes hex on first call) over `expo-secure-store` with
      `requireAuthentication: false` and the keychain key prefix `motard.`. FR-39, R2.
      Check: `cd mobile && npx tsc --noEmit` exit 0; unit test `mobile/test/unit/secureStore.test.ts`
      with a mocked `expo-secure-store` passes.
- [ ] T035 Implement `mobile/src/platform/pinVerifier.ts`: `hashPin(pin)` and `verifyPin(pin, stored)` with
      `react-native-argon2`, Argon2id, memory 65536 KiB, iterations 3, parallelism 4, matching
      `backend/src/infrastructure/auth/PasswordHasher.ts` (read it and copy its exact parameters and
      output encoding). Its output must verify with the backend's verifier. FR-05, R9.
      Check: `mobile/test/unit/pinVerifier.test.ts` (mocks the native module, asserts the parameters
      passed) passes.
- [ ] T036 Implement `mobile/src/print/renderHtml.ts`, `renderInvoiceHtml(data)` and
      `renderStatementHtml(data)`.
  - `react-dom/server` `renderToStaticMarkup` of `src/components/print/InvoicePrintDocument.tsx` and
    `src/components/print/PartyStatementDocument.tsx`, imported in place (add `@web/*` →
    `../src/*` to the tsconfig paths and the Metro watchFolders).
  - Inline the print CSS that `src/components/print/printPortal.ts` injects.
  - Embed the Arabic font file used by `src/styles.css` as a base64 `@font-face`.
  - Write the HTML to `printToFileAsync` in a thin wrapper `mobile/src/print/toPdf.ts`.

  FR-29, R8. Check: `mobile/test/unit/renderHtml.test.ts` (Node, jsdom not needed) renders a 3-line
  invoice fixture and asserts that the HTML contains each formatted amount, the currency labels "USD"
  or "SYP" exactly as the desktop prints them, and `dir="rtl"`.

- [ ] T037 Create `mobile/app/spikes.tsx`, a test-only screen, reachable only when `process.env.EXPO_PUBLIC_SPIKES === "1"` at build time (set by the workflow in T031; the M5 release build leaves it unset, so the screen is absent). It has buttons:
  - **S1 SQLite:** runs the six R2 criteria and prints PASS or FAIL with values; prints the
    `verifyPin` duration in milliseconds.
  - **S2 Use-cases:** in this task, a disabled button labelled "متاح بعد المرحلة 6" (available after
    phase 6). T050 enables it: it runs the receipt and 3-line sale use-cases through
    `mobile/src/core/container.ts` on a fresh database, then "Export for comparison" copies the
    decrypted database to the Downloads folder via `expo-sharing`.
  - **S3 PDF:** shares the invoice PDF and a 650-row statement PDF, and prints the render time.
  - **S5 First download:** in this task, a disabled button labelled "متاح بعد المرحلة 7" (available
    after phase 7). T063 enables it: it asks for the hub URL and an enrollment code, runs FR-07, kills
    itself at 40% when "kill at 40%" is ticked, and prints counts, balance differences and elapsed
    seconds.
  - **Money vectors (Hermes):** runs `packages/shared/src/money-vectors.json` through the real
    functions and prints passed/failed counts.

  Check: GATE-M.

- [ ] T038 Create `mobile/scripts/compare-db.mjs <a.db> <b.db>`. It opens both files with better-sqlite3
      from `backend/node_modules` and compares every business table (all tables except
      `motard_*`, `sync_*`, `idempotency_keys` and `audit_log`). Rows are matched by primary key and
      compared on every column except `created_at` and `updated_at`. It prints `0 differences` or each
      difference. Check: `mobile/test/unit/compare-db.test.ts`: two identical temp databases print
      `0 differences`, and one changed amount prints 1 difference.
- [ ] T039 Create `scripts/parity/seed-sync-volume.mjs`, modelled on `scripts/parity/seed-volume.mjs`.
  - Flags: `--hub http://127.0.0.1:18080`, `--invoices N`, `--parties N`, `--out <file>`.
  - Data shape: 80% customers and 20% suppliers, one deep customer with 20% of invoices, dates over
    four years, one receipt per invoice.
  - Enroll a test device through the hub's enrollment endpoints, then send every party, invoice and
    receipt as sync units through `POST /api/sync/push` in the same unit shape the desktop client
    builds (read `backend/src/application/use-cases/sync/syncEnqueue.ts` for the payloads).
  - Write `{ counts, partyBalances }` to `--out`.

  R14. Check: with the cert stack running (`node tests/e2e/cert-stack.mjs`,
  `CERT_PG_URL=postgresql://postgres:postgres@localhost:5432/postgres`, `E2E_ADMIN_PASSWORD=CiTestAdmin!Pass9`),
  run `--invoices 1000 --parties 100`. Then `GET /api/sync/status` reports `pendingCount` 0, and the
  hub's party balances from `/api/reports/party-balances` equal the out file.

- [ ] T040 CHECKPOINT "feat(mobile): APK workflow, native adapters, spike screen, test data generator".
      After the push, check the run: `gh run list --workflow mobile-android.yml --limit 1` (if `gh` is
      available) shows `completed success`. Otherwise write "APK run to be checked by owner" in
      evidence/T040.md.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STOP-POINT 1 — the first cloud session ENDS after T040 (the APK has been built and pushed).
The agent does not start T041–T044 or Phase 6 in this session. Its last message to the owner is:
"Session 1 done. Install the APK from Actions → mobile-android, then run T041 and T042 and commit
evidence/T041.md and evidence/T042.md (T043)."
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### OWNER-LOCAL M0 (done by the owner between session 1 and session 2)

- [ ] T041 OWNER-LOCAL S1 + money vectors on Hermes. Steps for the owner:
  1. On github.com open the repository → Actions → "mobile-android" → the latest run on `feat/mobile`
     → download the `motard-mobile-test-apk` artifact (a zip), and unzip it.
  2. Copy the `.apk` to the phone (USB or Google Drive), open it, and allow "install unknown apps" for
     that app once.
  3. Open Motard ERP → the Spikes screen → press "S1 SQLite", then "Money vectors (Hermes)".
  4. Take screenshots of each result.
  5. Write the results into `specs/002-mobile-app/evidence/T041.md` in exactly this form, one line
     each:
     - `S1-1 encrypted: PASS|FAIL`
     - `S1-2 migrations+fingerprint: PASS|FAIL`
     - `S1-3 sync calls in transaction: PASS|FAIL`
     - `S1-4 motard functions: PASS|FAIL <message>`
     - `S1-5 bigint round-trip: PASS|FAIL`
     - `S1-6 pragmas: PASS|FAIL`
     - `ARGON2-MS: <number>`
     - `MONEY-VECTORS-HERMES: <passed>/<total>`
- [ ] T042 OWNER-LOCAL S3 PDF. In the Spikes screen press "S3 PDF". Open both PDFs and compare them with
      the desktop prints of the same documents (amounts, currencies, Arabic shaping). Write PASS or FAIL
      and the render time into `specs/002-mobile-app/evidence/T042.md`.
- [ ] T043 OWNER-LOCAL Hand the results to session 2. On the computer, in the repository folder:
  1. `git pull`
  2. Create or update the two evidence files.
  3. `git add specs/002-mobile-app/evidence/T041.md specs/002-mobile-app/evidence/T042.md`
  4. `git commit -m "evidence(mobile): M0 device results"`
  5. `git push`

  Without git on the computer: on github.com open the repository, switch to branch `feat/mobile`, go
  to `specs/002-mobile-app/evidence/`, choose Add file → Create new file, name it `T041.md` (then
  `T042.md`), paste the results, and Commit changes.

  Then start the second cloud session with the prompt: "Continue specs/002-mobile-app/tasks.md from
  SESSION-2 START." (S2 and S5 need code from phases 6 and 7; they run on the phone in T086.)

- [ ] T044 CONDITIONAL (run first in session 2, only if evidence/T041.md says `S1-4 motard functions: FAIL UDF_UNSUPPORTED`): fallback F1-a.
  - Write `mobile/native/motard_sqlite_ext.c` implementing `motard_pgdiv`, `motard_dectext`,
    `motard_decsum` (aggregate), `motard_re_substr` and `motard_re_match`, with the exact semantics of
    `backend/src/infrastructure/orm/sqlite/numericFunctions.ts`.
  - Load it through op-sqlite's extension loading in `BetterSqliteShim.ts`, and build it in the
    workflow's Gradle step via a config plugin `mobile/plugins/withMotardSqliteExt.js`.

  Check: `mobile/test/unit/ext-parity.test.ts` compiles the C file with `gcc -shared -fPIC` on Linux,
  loads it into better-sqlite3 with `loadExtension`, and asserts byte-identical results with the JS
  functions on every case of `backend/tests/sqlite/pg-numeric-div.test.ts` and
  `backend/tests/sqlite/like-contains.test.ts`.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SESSION-2 START — the second cloud session begins here, and follows these rules in order:

1. If `specs/002-mobile-app/evidence/T041.md` does not exist, or lacks any `S1-` line: STOP. Reply
   "Waiting for the owner's T041 results", and do nothing else.
2. If `S1-1`, `S1-3`, `S1-5` or `S1-6` is FAIL: STOP (fallback F1-b, constitution VII: no
   unencrypted or unsafe fallback). Reply with the failing lines and ask the owner for a decision.
3. If `S1-4` is `FAIL UDF_UNSUPPORTED`: do T044 first, then T040's CHECKPOINT again, and tell the
   owner to repeat T041 with the new APK. Continue with Phase 6 meanwhile: Phase 6 is verified on
   Node, not on the phone.
4. If `S1-2` is FAIL: fix `mobile/src/core/runtime.ts` (T027) until `test/unit/runtime-node.test.ts`
   passes, push, and ask the owner to repeat T041. Continue with Phase 6.
5. Otherwise (all PASS): skip T044 and continue with Phase 6.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## Phase 6: Foundational core (blocks every story) [M1]

- [ ] T045 (R1) Read `backend/src/infrastructure/di/sqliteContainer.ts` and list every port and repository it
      wires that is needed by these use-case folders: `backend/src/application/use-cases/{cashbox,dashboard,expenses,inventory,invoices,ledger,orders,parties,profit,returns,settings,statements,sync,vouchers}`.
      Write the list, with each item's source file, to `specs/002-mobile-app/evidence/T045-ports.md`.
      Mark which ports need phone adapters (secrets, logger, config, fingerprint, licence). Also list
      every `config.<field>` read by the files the phone bundles (grep `config\.` in the files that
      import `config/env`), and every named export of `backend/src/infrastructure/config/logger.ts`
      they import.
      Check: the file exists and names every constructor argument used by those use-cases.
- [ ] T046 [P] Implement `mobile/src/platform/logger.ts`: an object with `info`, `warn`, `error`, `debug`
      and `child()` writing to `console` only (NFR-12). It provides every named export of `backend/src/infrastructure/config/logger.ts` listed in T045, with the same shape (T020 maps that file here). `pino` stays banned.
      Check: `mobile/test/unit/logger.test.ts` asserts every export listed in T045 exists, and passes.
- [ ] T047 [P] (FR-04, FR-43) Implement `mobile/src/core/appState.ts`: it reads and writes `app-state.json` in
      `FileSystem.documentDirectory`, with fields `appLockEnabled` (boolean, default true),
      `lastForegroundAt` (ISO string or null), `updateChannel` ("play" | "apk"), and
      `lastVersionCheckAt` (ISO string or null). Writes are atomic: write a temp file, then move it.
      data-model.md. Check: `mobile/test/unit/appState.test.ts` (mocked FileSystem) passes.
- [ ] T048 Implement `mobile/src/core/config.ts`: `buildConfig(enrollment)` returns a frozen object with
      `hubUrl`, `tenantId`, `syncDeviceId`, `deviceKind: "phone"` and `appVersion` (from
      `expo-constants`). It has no `process.env` reads. Also implement `mobile/src/platform/envConfig.ts`
      (mapped by T020 in place of `backend/src/infrastructure/config/env.ts`): it exports `config`
      with every field listed in T045, holding the phone values (hub URL and identity from
      `buildConfig`, fixed values for the rest copied from the desktop SQLite defaults in `env.ts`).
      FR-08, R1. Check: unit test asserts every T045 field exists.
- [ ] T049 Implement `mobile/src/core/hubHttp.ts`: wraps `fetch` so that every request to `/api/sync/push`
      and `/api/sync/pull` carries `X-Motard-Money-Version: MONEY_RULES_VERSION`. It maps
      `426 SYNC_VERSION_MISMATCH` to the typed error `VersionMismatchError`, `403 SYNC_DEVICE_REVOKED` to
      `DeviceRevokedError`, and `403 SYNC_UNKNOWN_DEVICE` to `UnknownDeviceError`. FR-38, FR-40.
      Check: `mobile/test/unit/hubHttp.test.ts` (mocked fetch) asserts the header and the three mappings.
- [ ] T050 Implement `mobile/src/core/container.ts`: it builds the repositories and use-cases from T045
      with the phone adapters and `deviceKind: "phone"` passed to the number-block path (BC-1). Every
      exported use-case function is wrapped in `runSerial` (T024). It must not import
      `backend/src/infrastructure/di/sqliteContainer.ts`. R1, R3.
      Also:
  - Create `mobile/src/core/spikeS2.ts`, exporting `runS2(container)`. It sets the deterministic UUID
    sequence (T023 `setUuidSequenceForSpike("s2")`), then records one receipt of 500 USD at rate 14500
    and one 3-line sale with fixed inputs and fixed document dates (2026-01-15).
  - Enable the "S2 Use-cases" button in `mobile/app/spikes.tsx` (T037) to call `runS2`.
  - Create `mobile/scripts/s2-reference.mjs`. It runs the same `runS2` under Node through the
    container over better-sqlite3, and writes `specs/002-mobile-app/evidence/s2-reference.db`.
    Commit that file.
    Check: GATE-M (lint proves there are no banned imports).
- [ ] T051 Create the parity harness `mobile/test/parity/harness.ts`.
  - Start the cert stack (`tests/e2e/cert-stack.mjs`).
  - Create a "phone": the mobile container over a temp better-sqlite3 database via the Node shim,
    enrolled as a device of kind phone.
  - Create a "desktop": a second temp SQLite file driven through the backend's own
    `sqliteContainer.ts`, enrolled as a desktop device.
  - Expose `syncAll()`, which runs push+pull on both until the hub reports 0 pending.
  - Expose `compareAll()`, which runs `mobile/scripts/compare-db.mjs` logic on phone vs desktop and
    compares the hub's party balances and cashbox per currency with both.

  Check: `mobile/test/parity/smoke.test.ts` (start, enroll both, syncAll, compareAll → 0 differences
  on empty data) passes under GATE-P.

- [ ] T052 Add parity scenarios in `mobile/test/parity/scenarios.test.ts` (G2). They call use-cases directly,
      with no UI:
  - (a) a receipt on the phone
  - (b) a 3-line sale on the phone
  - (c) a sale cancel on the desktop
  - (d) a voucher replace on the phone
  - (e) a claim race: the same roll sold on both while "offline" (no sync between the writes); the
    first to push wins and the loser's document is cancelled locally (FR-34, E1)
  - (f) phone block exhaustion: 101 invoices offline, so fallback numbering is used and no number
    overlaps (FR-35, E2)
  - (g) hub epoch change: rebase (FR-36, E4)

  SC-001, SC-002. Check: GATE-P, all 7 scenarios with 0 differences.

- [ ] T053 Implement `mobile/src/core/syncLoop.ts` per FR-32. It runs on start, on foreground (AppState),
      on network regain (`@react-native-community/netinfo`, installed via `npx expo install`), 2 seconds
      after the last write, and every 20 s in the foreground. Retries come at 30 s and 120 s. Pull pages use
      `limit=100`; pushes drain the outbox in batches of 50 with progress (E3). It reads the hub's HTTP `Date` header on each response and emits `clockSkew` when it differs from the phone clock by more than 5 minutes (E16). It calls the shared sync client functions from
      `backend/src/application/use-cases/sync/syncUseCases.ts`; it never writes outbox rows itself (FR-31,
      FR-33). On `VersionMismatchError` it stops and emits `versionMismatch`; on `DeviceRevokedError` it
      emits `revoked`. Check: `mobile/test/unit/syncLoop.test.ts` with fake timers asserts the schedule,
      the retries, the 50-unit push batches, and the `versionMismatch`, `revoked` and `clockSkew` events.
- [ ] T054 Register background sync in `mobile/src/core/backgroundSync.ts` with `expo-background-task`
      (minimum interval 15 minutes), calling one `syncLoop` run inside `runSerial`. NFR-13.
      Check: GATE-M.
- [ ] T055 UI foundation, part 1:
  - `mobile/src/ui/theme.ts`: copy the color, radius and font tokens from `src/styles.css` (light
    theme only, Clarification Q5).
  - Spacing scale 4/8/12/16/24/32. Body text 16 sp minimum. Touch target constant 48 dp.
  - RTL comes from the `expo-localization` plugin settings in T019 (`supportsRTL`, `forcesRTL`), so
    no runtime reload is needed. `mobile/src/ui/rtl.ts` only asserts `I18nManager.isRTL === true` at
    start-up and logs an error otherwise.

  UX-06, NFR-09, NFR-10. Check: `mobile/test/unit/theme.test.ts` asserts body ≥ 16 and touch ≥ 48.

- [ ] T056 [P] UI foundation, part 2. Create these in `mobile/src/ui/`:
  - `Field.tsx`: a label tied to its input through `accessibilityLabelledBy` (the desktop `FormField`
    rule)
  - `MoneyText.tsx`: always renders the currency code next to the amount, and for a negative amount
    shows a minus sign plus the `negative` color token (UX-05)
  - `MoneyInput.tsx`: numeric keypad, thousands separators while typing, no more than 2 decimals,
    using `hasMoreThan2dp` from `packages/shared/src/precision.ts` (UX-08)
  - `Toast.tsx`: `success` and `error` variants, never swapped (UX-07)
  - `PrimaryActionBar.tsx`: fixed at the bottom, stays above the keyboard (UX-02)

  Check: `mobile/test/unit/ui-*.test.tsx` with `@testing-library/react-native` assert currency
  presence, the negative sign and color, the decimal limit, and the toast variant names.

- [ ] T057 [P] Create `mobile/src/ui/SyncChip.tsx`. It shows four states: synced, pending N, offline,
      attention. The state comes from a hook `mobile/src/hooks/useSyncState.ts` that reads the outbox
      counts through the container and the netinfo state. UX-03.
      Check: the unit test covers all four states.
- [ ] T058 Create `mobile/app/_layout.tsx`: providers (React Query `QueryClient`, theme), RTL init, the
      SyncChip in the header of every screen, and `expo-splash-screen` with the animated logo for at most
      1.5 s while `openRuntime` runs (FR-01). Use the company logo asset from `desktop-app/` or `public/`
      (search with `git ls-files | grep -i logo`). Create `mobile/app/(tabs)/_layout.tsx`: bottom tabs in
      RTL order Home, Customers & suppliers, Add, Inventory, More, filtered by role (UX-04). Screens not
      built yet show an Arabic "قريباً" (coming soon) placeholder. Check: GATE-M.
- [ ] T059 (FR-09, FR-13) Create `mobile/src/hooks/queryKeys.ts` and `mobile/src/hooks/invalidate.ts`.
      `invalidateFinancialViews(qc)` invalidates the dashboard, parties, statements, cashbox and sync
      keys, the phone counterpart of the frontend rule. Check: unit test.
- [ ] T060 Run GATE-M and GATE-P. Check: both rules.
- [ ] T061 CHECKPOINT "feat(mobile): core container, sync loop, parity suite, UI foundation".

## Phase 7: US1 — Enroll a phone and download the company data (Must, P1) [FR-06, FR-07, FR-08, E15]

**Independent test**: on the cert hub seeded with 1,000 invoices (T039), enroll a fresh phone and
compare counts and balances with the hub (automated under Node by T066; on device by T086 step 9).

- [ ] T062 [US1] Implement `mobile/src/core/enrollment.ts`: `enroll(hubUrl, code)` calls
      `POST /api/sync/enroll`, then `POST /api/sync/device-token`. It stores the device credential and
      tokens with `secureStore`, creates the installation id, writes `motard_meta` through the same
      function the desktop runtime uses to create it (found in T045), and fixes the tenant (FR-08).
      Invalid or expired code → throw `EnrollmentRefusedError` with the hub's Arabic message.
      Check: `mobile/test/unit/enrollment.test.ts` (mocked hub) passes.
- [ ] T063 [US1] Implement `mobile/src/core/firstDownload.ts`: it loops the shared pull from `afterSeq`
      = the stored cursor (0 the first time), `limit=100`, and materializes each page. It persists the
      cursor after each page, so it resumes (FR-07). Progress is reported as
      `{ percent: cursor / headSeq, applied }`. Before starting it estimates the size (headSeq × 2 KB)
      against `FileSystem.getFreeDiskStorageAsync()` and refuses with both numbers when space is short
      (E15). Also enable the "S5 First download" button in `mobile/app/spikes.tsx` (T037) with this
      function. Check: unit test with a mocked pull of 3 pages, plus a kill-after-page-2 resume case.
- [ ] T064 [US1] Create `mobile/app/enroll.tsx`.
  - Steps: QR scan (`expo-camera` barcode scanner, accepting the JSON `{hub, code}` from BC-4) or typed
    hub URL and code → progress screen (percent and count) → done.
  - Arabic copy throughout.
  - Errors: invalid code, network loss (it shows "سيتابع عند عودة الاتصال", "it will continue when the
    connection returns"), low storage (E15).

  Check: GATE-M; `mobile/test/unit/enroll-screen.test.tsx` renders the three error states.

- [ ] T065 [US1] Route guard in `mobile/app/_layout.tsx`: not enrolled → `/enroll`; enrolled with an
      unfinished first download → the progress screen. Check: unit test of the guard function
      `mobile/src/core/routeGuard.ts`.
- [ ] T066 [US1] Add a parity scenario (h) in `mobile/test/parity/scenarios.test.ts`. Seed the hub with
      `seed-sync-volume.mjs --invoices 1000 --parties 100`, enroll a fresh phone, run `firstDownload`,
      then compare the phone with the generator's out file (counts and every party balance). Also kill
      and resume at 40%. SC-001. Check: GATE-P.
- [ ] T067 [US1] CHECKPOINT "feat(mobile): enrollment and resumable first download (US1)".

## Phase 8: US2 — Sign in once, stay signed in, unlock with fingerprint (Must, P1) [FR-01–FR-05, FR-41]

**Independent test**: sign in, go offline, background the app for 61 s, unlock, and still be signed
in.

- [ ] T068 [US2] Implement `mobile/src/core/session.ts`.
  - `pinLogin(userId, pin)` calls `POST /api/auth/pin-login` and stores the tokens.
  - On success it stores the offline verifier `hashPin(pin)` for that user (T035).
  - `refresh()`: only a 401 or 403 from `/api/auth/refresh` ends the session. Any other 403 does not
    (FR-03).
  - `offlineLogin(userId, pin)` verifies against the stored verifier (FR-05).
  - `logout()` first counts pending outbox units; when the count is above 0 it returns `{ needsConfirm: true, pending }`, and the screen warns "<N> عمليات لم تُرسل بعد" ("<N> operations not sent yet") before confirming (E8). After confirmation it calls `POST /api/auth/logout` when online, then clears the tokens.

  Check: `mobile/test/unit/session.test.ts` covers refresh-401 ends the session, other-403 keeps it,
  offline login success and failure, a one-year token, and the pending-units confirmation (E8).

- [ ] T069 [US2] Create `mobile/app/login.tsx`: a PIN picker listing the users from
      `GET /api/auth/device-roster` (cached locally after first fetch, so it works offline). It has a
      numeric PIN pad and an Arabic password fallback link (FR-02). Check: GATE-M + render test.
- [ ] T070 [US2] Implement `mobile/src/core/appLock.ts` and an overlay in `_layout.tsx`.
  - On cold start, and when returning after ≥ 60 s in the background (`lastForegroundAt`), cover the
    app and require `expo-local-authentication`, with PIN fallback through `verifyPin` (FR-04).
  - Hide the content in the Android recent-apps view by rendering the cover whenever `AppState`
    goes to `inactive` or `background` (FR-41). Screenshots stay allowed.

  Check: unit test with fake timers: 59 s → no lock; 60 s → lock.

- [ ] T071 [US2] Implement role rules: `mobile/src/core/roles.ts` exports `canWriteOffline(role)` (admin
      and accountant true; warehouse and viewer false) and `isAdminLike(role)` (admin or accountant,
      matching `hasAdminPrivileges`), plus a strict `isAdmin(role)` used only for device revoke. The role is read from the local users table on every check, never cached in memory, so a role change pulled from the hub applies at once (E18). FR-05,
      constitution VI. Check: unit test over the 4 roles.
- [ ] T072 [US2] CHECKPOINT "feat(mobile): PIN sign-in, permanent session, app lock (US2)".

## Phase 9: US14 — Sync state, notifications, update required (Must, P1) [FR-37, FR-38, E5, E9]

- [ ] T073 [US14] Create `mobile/app/(tabs)/more/sync.tsx`: a read-only screen showing the pending count,
      last run, last error, and the rejected and dead documents (from the local outbox statuses), each with
      the text "يجب الحل من الديسكتوب" ("must be resolved on the desktop"). There is no requeue button
      (FR-37, E5). Check: render test asserts the text and the absence of any requeue control.
- [ ] T074 [US14] Implement `mobile/src/core/notify.ts` with `expo-notifications`, local notifications
      only. After each sync run it fires:
  - one notification per newly rejected document, naming its number
  - one when sync stops (version mismatch, revoked, unknown device)
  - one for fabrics that fall below `minStockKg` after a pull

  It asks permission on first use. Check: unit test with the mocked module asserts the three triggers.

- [ ] T075 [US14] Create `mobile/src/ui/UpdateBanner.tsx`, shown on every screen while
      `versionMismatch` is set: "تحديث مطلوب" ("update required"), with a button opening the Play Store
      listing or the APK URL. Local work continues (E9). Check: render test.
- [ ] T076 [US14] CHECKPOINT "feat(mobile): sync status, local notifications, update banner (US14)".

## Phase 10: US3 — See today's money at a glance (Must, P1) [FR-09, FR-10]

- [ ] T077 [US3] Create `mobile/src/hooks/useDashboard.ts`, calling the dashboard use-case through the
      container (`backend/src/application/use-cases/dashboard/`). Check: unit test with a seeded temp
      database returns separate USD and SYP figures.
- [ ] T078 [US3] Create `mobile/app/(tabs)/index.tsx` (Home) with:
  - one cashbox card per currency (never combined)
  - today's sales
  - receivables and payables
  - the sync chip and last successful sync time
  - quick actions filtered by `canWriteOffline` and role: new sale, receipt, payment, expense, find
    party (FR-10)

  Actions for screens not built yet go to their "قريباً" placeholders. Check: render tests:
  - a viewer sees no write actions
  - 1,250.50 USD and 3,400,000 SYP render as two cards

- [ ] T079 [US3] Run GATE-M and GATE-P.
- [ ] T080 [US3] CHECKPOINT "feat(mobile): home summary (US3)".

## Phase 11: US15 — Lock out a lost phone (Must, P2, part of M1) [FR-39, FR-40, G5]

- [ ] T081 [US15] Implement `mobile/src/core/wipe.ts`: `wipeDevice()` closes the database, deletes the
      database file, every secure-store key with the prefix `motard.`, `app-state.json`, and the cached
      PDFs folder, then navigates to `/enroll`. It is called when `syncLoop` emits `revoked` (T053), even when unsynced units exist (lost-device policy, E7).
      Check: unit test with mocked FileSystem and secure store asserts every deletion, in that order.
- [ ] T082 [US15] Add a parity scenario (i): an admin revokes the phone's device on the cert hub, the next
      `syncAll` raises `DeviceRevokedError`, and `wipeDevice` removes the temp database file.
      Check: GATE-P.
- [ ] T083 [US15] CHECKPOINT "feat(mobile): remote revoke and local wipe (US15)".

## Tier A closing

- [ ] T084 Run GATE-D in full (backend files changed in Phase 3), GATE-M and GATE-P. Write the three
      summaries to `specs/002-mobile-app/evidence/tierA.md`.
- [ ] T085 CHECKPOINT "chore(mobile): Tier A complete". Then confirm that the `mobile-android` workflow
      run for this commit succeeded (`gh run list --workflow mobile-android.yml --limit 1`), or note that
      the owner must check.
- [ ] T086 OWNER-LOCAL Tier A acceptance on the phone (G1, NFR-04, R3 S2, R5 S5):
  1. Download the newest APK artifact (as in T041) and install it over the old one.
  2. Enroll with a code created on the desktop (Settings → Sync → Devices).
  3. Wait for the first download to finish.
  4. Sign in with your PIN.
  5. Put the phone in airplane mode, wait 1 minute in another app, return, and unlock with your
     fingerprint.
  6. Check that Home shows USD and SYP separately and the sync chip shows "offline".
  7. Turn airplane mode off and check the chip turns "synced".
  8. S2 on the phone: Spikes → "S2 Use-cases" → "Export for comparison"; copy the file to the computer
     and run `node mobile/scripts/compare-db.mjs <phone.db> <desktop-reference.db>` with the reference
     file the agent wrote in `specs/002-mobile-app/evidence/s2-reference.db` (T050). It must print
     `0 differences`.
  9. S5 on the phone: seed a reachable hub (the test hub on Render, or the cert stack on a computer on
     the same Wi-Fi) with `node scripts/parity/seed-sync-volume.mjs --hub <url> --invoices 100000 --parties 10000 --out s5.json`,
     create an enrollment code, then Spikes → "S5 First download" with "kill at 40%" ticked; reopen and
     press it again. Record counts, balance differences (must be 0) and elapsed time, and decide whether
     the time is acceptable (research R5, F5).
  10. On the desktop, revoke the phone and check the phone returns to the enrollment screen.

  Write PASS or FAIL per step (and the S5 numbers) into `specs/002-mobile-app/evidence/T086.md`.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CUT LINE A — Tier A ends here. Everything above must be done with the $100 credit.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# TIER B — only if credit remains, in this exact order

## Phase 12: US4 — Find a party and read their statement (Must, P1) [FR-11–FR-14, E12]

- [ ] T087 [US4] Create `mobile/src/hooks/useParties.ts`: search through the shared party search
      use-case (the same matching as `/parties/search`), sorted by a local most-recently-used list stored in
      `app-state.json` (add the field `recentPartyIds: string[]`, max 50). FR-11.
      Check: unit test, three letters on 2,000 seeded parties returns within 150 ms under Node (NFR-02
      proxy).
- [ ] T088 [US4] Create `mobile/app/(tabs)/parties/index.tsx`: a search field and a card list (UX-01),
      with a customers/suppliers segmented filter. Check: render test.
- [ ] T089 [US4] Create `mobile/app/(tabs)/parties/[id].tsx`: the balance per currency (MoneyText),
      phone number, recent documents, and a "كشف الحساب" (statement) button. FR-12. Check: render test.
- [ ] T090 [US4] Create `mobile/src/hooks/useStatement.ts` and
      `mobile/app/(tabs)/parties/[id]/statement.tsx`. The statement use-case is paged with `nextCursor`,
      200 per page, followed to the end. The list is virtualized with `FlatList`. The order and running
      balance come from the use-case (FR-13). Check: unit test, a 650-row seeded statement loads all 650
      rows, and the last running balance equals the use-case's closing balance. Invoice-before-payment
      order holds for a same-transaction pair.
- [ ] T091 [US4] Create `mobile/app/(tabs)/parties/form.tsx`, for create and edit (admin and accountant
      only). Name uniqueness errors come back from the use-case and are shown with the desktop's Arabic
      message plus the hint "استخدم صيغة: الاسم — المدينة" ("use the format: name — city"). FR-14, E12.
      Check: render test of the duplicate error.
- [ ] T092 [US4] CHECKPOINT "feat(mobile): parties, party detail and full statement (US4)".

## Phase 13: US5 — Receipts, payments and expenses offline (Must, P1) [FR-20–FR-23, E10, E11]

- [ ] T093 [US5] Create `mobile/app/(tabs)/add/receipt.tsx` and `payment.tsx`, sharing the component
      `mobile/src/ui/VoucherForm.tsx`.
  - Steps: party (bottom-sheet search) → amount (MoneyInput) + currency + rate (pre-filled from
    `GET /api/fx/reference-rate` when online, cached for offline; FR-19) + optional write-off + optional
    invoice settlement → review → save through the voucher use-case.
  - A negative resulting cash shows a warning dialog before the save and saves on confirm (E11).
  - A locked day or closed year shows the use-case's message (E10).

  Check: render tests for the warning and the locked-day message.

- [ ] T094 [US5] Voucher amend: the "تعديل" (amend) action calls the replace use-case (the one behind
      `POST /receipts/:id/replace`) in one call. FR-21. Check: parity scenario (d) from T052 still passes,
      and a unit test asserts that a single use-case call is made.
- [ ] T095 [US5] Create `mobile/app/(tabs)/add/expense.tsx`: the name autocomplete uses the expense-names
      use-case; amount; currency; save; cancel from the detail view. FR-22. Check: render test.
- [ ] T096 [US5] Create `mobile/app/(tabs)/more/cashbox.tsx`: cashbox state, movements by day with a date
      picker, the balance at a date, and an add-manual-movement form. FR-23.
      Check: unit test, a manual movement dated yesterday changes yesterday's and today's balances.
- [ ] T097 [US5] Run GATE-M and GATE-P.
- [ ] T098 [US5] CHECKPOINT "feat(mobile): receipts, payments, expenses, cashbox (US5)".

## Phase 14: US6 — Sell from the phone offline (Must, P1) [FR-15, FR-17, FR-19, FR-34, E1]

### Sale invoice creation (T099–T102)

- [ ] T099 [US6] Create `mobile/src/ui/RollPicker.tsx`, a bottom sheet fabric → colour → roll that shows
      the remaining kg. Rolls with 0 kg are not selectable. Check: render test.
- [ ] T100 [US6] Create `mobile/app/(tabs)/add/sale/` (FR-15, FR-19: the rate is pre-filled exactly as in T093) with three steps: `customer.tsx`, `lines.tsx`
      (add, edit and remove lines: kg, pieces with 0 allowed, price, fixed line discount) and `review.tsx`
      (fixed header discount, tax, shipping, optional payment, rate). Draft state lives in
      `mobile/src/hooks/useSaleDraft.ts` (memory only). Totals shown are computed by calling the shared
      calculation from `packages/shared` used by the invoice use-case, never by new code.
      Check: a unit test feeds 10 cases from `money-vectors.json` (op `invoiceTotal`) through the draft's
      displayed total.
- [ ] T101 [US6] Save: call the sale invoice use-case once (number + header + lines + ledger + voucher +
      cashbox + stock in one transaction). The done screen offers Share PDF (T036), Send to customer
      (placeholder until US13) and New. Check: parity scenario (b) passes, and a render test of the done
      screen.
- [ ] T102 [US6] Create the invoice detail `mobile/app/invoices/[id].tsx` with a cancel action for
      admin and accountant. Cancel calls the cancel use-case (reversal entries). FR-17. Check: parity
      scenario (c) adapted to cancel on the phone passes.

### Claim-loss handling (T103)

- [ ] T103 [US6] Claim loss UX: when sync marks the phone's invoice rejected with a claim conflict, show
      an Arabic alert naming the invoice number and the roll, and fire the T074 notification. FR-34.
      Check: parity scenario (e) asserts that the local document is cancelled, and a unit test asserts the
      alert text contains both identifiers.
- [ ] T104 [US6] Run GATE-M, GATE-P and GATE-D steps 6–7.
- [ ] T105 [US6] CHECKPOINT "feat(mobile): sale invoice with claim-loss handling (US6)".
- [ ] T106 OWNER-LOCAL (FR-15, FR-20, SC-001) Tier B acceptance:
  1. Install the newest APK.
  2. Put the phone in airplane mode.
  3. Record a receipt of 500 USD and a 3-line sale.
  4. Reconnect.
  5. On the desktop, check that both documents show with the same amounts, balances and cashbox.

  Write the result into `specs/002-mobile-app/evidence/T106.md`.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CUT LINE B — Tier B ends here. Everything below is deferred to the next credit.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# DEFERRED — next credit, in this order

## Phase 15: US10 — Inventory, roll adjust, stock count (Must, P2) [FR-24–FR-26]

- [ ] T107 [US10] (FR-24, FR-25) Create `mobile/app/(tabs)/inventory/index.tsx`, `[fabricId].tsx` and `roll/[rollId].tsx`:
      browse and search, remaining kg, a low-stock badge when remaining < `minStockKg`, and roll movements.
      Check: render test of the badge (50 kg minimum, 32 kg remaining).
- [ ] T108 [US10] (FR-25) Roll adjust form (allowed roles) calling the adjust use-case. A price edit is refused
      after the first sale with the use-case message. Remaining kg must not go below 0. Check: unit tests
      for the refusal and the negative guard.
- [ ] T109 [US10] Stock count screen `mobile/app/(tabs)/inventory/count.tsx`, using the count-sheet and
      count-post use-cases. Admin and accountant may count offline; warehouse and viewer cannot while
      offline (Clarification Q2). Check: unit test, a count of 18.0 for a 20.0 kg roll posts a −2.0
      adjustment, and the role rule holds offline.
- [ ] T110 [US10] CHECKPOINT "feat(mobile): inventory and stock count (US10)".

## Phase 16: US12 — Reports and profit (Must, P3) [FR-28]

- [ ] T111 [US12] Create `mobile/app/(tabs)/more/reports/index.tsx` and `[slug].tsx`: summary, party
      balances, detail reports and profit summary/details for a date range, figures per currency. Check:
      unit test, profit revenue = subtotal − discount, and cost uses `cost_per_kg`, equal to the
      use-case output.
- [ ] T112 [US12] CHECKPOINT "feat(mobile): reports and profit (US12)".

## Phase 17: US7 — Purchase (entry) invoice (Must, P2) [FR-16]

- [ ] T113 [US7] Create `mobile/app/(tabs)/add/entry/` steps (supplier → lines that may introduce new
      colours and rolls → review). Save calls the entry invoice use-case once, so new colours and rolls are
      created in the same transaction. The client never creates them first. Check: a parity scenario with a
      forced failure after the colour insert leaves no colour, roll or ledger row.
- [ ] T114 [US7] CHECKPOINT "feat(mobile): entry invoice (US7)".

## Phase 18: US8 — Returns (Must, P2) [FR-18]

- [ ] T115 [US8] Create `mobile/app/(tabs)/add/return.tsx`: pick the source invoice, then its lines,
      allowing weight-only (0 pieces). Valuation comes from the use-case. Cancel writes reversals. Check: a
      parity scenario returning 2 lines at rate 14,500 equals the desktop.
- [ ] T116 [US8] CHECKPOINT "feat(mobile): returns (US8)".

## Phase 19: US9 / US11 — Cashbox close and orders [FR-23, FR-27]

- [ ] T117 [US11] Create `mobile/app/(tabs)/more/orders/` (list, create, detail with cancel and fulfil;
      pending conflicts read-only with "يجب الحل من الديسكتوب", "must be resolved on the desktop").
      Check: render tests.
- [ ] T118 [US9] Cashbox close-day (Should): send only date, counted amount and currency to the close-day
      use-case, admin and accountant only. Check: unit test of the payload shape.
- [ ] T119 CHECKPOINT "feat(mobile): orders and cashbox close (US9, US11)".

## Phase 20: US13 — Share PDF and send to customer (Must, P2) [FR-29, FR-30, E13, E14]

- [ ] T120 [US13] Create `mobile/src/core/share.ts`: `sharePdf(uri)` via `expo-sharing`, and
      `sendToCustomer(phone, note, pdfUri)`.
  - Use an Android intent to package `com.whatsapp` with `jid=<digits>@s.whatsapp.net` and the PDF
    stream, via `expo-intent-launcher`.
  - If WhatsApp is missing or the intent fails: open `https://wa.me/<digits>?text=<note>`, then the
    share sheet.
  - Nothing is sent automatically.

  Check: unit tests for the fallback order.

- [ ] T121 [US13] Wire "Send to customer" on the invoice, voucher, return and statement screens. With no
      saved phone number, prompt for one and offer to save it to the party (E13). Check: render test of the
      prompt.
- [ ] T122 [US13] CHECKPOINT "feat(mobile): PDF share and send to customer (US13)".

## Phase 21: BC-5 and in-app update check [FR-43, FR-42]

- [ ] T123 Create `backend/src/presentation/routes/mobileVersion.route.ts`, registered in
      `backend/src/presentation/server.ts` beside the health routes, per contracts/backend-changes.md
      BC-5, plus `backend/tests/mobile-version-route.test.ts`. Check: the test passes, then GATE-D in full.
- [ ] T124 (FR-43) Create `mobile/src/core/updateCheck.ts`: on the APK channel, at most once a day, call
      `GET /api/mobile/version` and offer the download when `latestVersionCode` is greater than the app's.
      Check: unit test.
- [ ] T125 CHECKPOINT "feat: mobile version manifest and update check (BC-5, FR-43)".

## Phase 22: Should and Could [US16, US17, BC-4]

- [ ] T126 [US16] BC-4: create `src/components/sync/EnrollmentQr.tsx` and render it in
      `src/components/settings/HubDevicesCard.tsx` next to the text code. The QR payload is the JSON
      `{ "hub": <url>, "code": <code> }`. Add one QR library to the root `package.json`, then create
      `src/components/sync/__tests__/EnrollmentQr.test.tsx`. Check: GATE-D steps 6–7.
- [ ] T127 [US16] Party opening balance form (admin and accountant) calling the opening use-case.
      Check: a parity scenario with a supplier opening of −1,000 USD equals the desktop statement start.
- [ ] T128 [US16] Desktop revoke screen shows the phone's unsynced count. It is read from
      `GET /api/sync/devices` when that endpoint exposes per-device pending; otherwise record "not
      available" in evidence and skip. Check: GATE-D steps 6–7.
- [ ] T129 [US17] Could: today's-cash home widget, saved note templates, and a tablet two-pane parties
      screen at ≥ 600 dp. Each item is a separate commit with its own render test in `mobile/test/unit/`. Check: GATE-M after each item.

## Phase 23: Polish, performance and release [NFR-01–NFR-13, SC-003–SC-008, M5]

- [ ] T130 (NFR-02, NFR-03) Performance under Node: `mobile/test/perf/volume.test.ts` seeds 100,000 invoices into a temp
      database (with `scripts/parity/seed-volume.mjs` logic adapted to SQLite), then measures party search,
      the first statement page and an invoice save. It records the numbers in `evidence/T130.md` against
      NFR-02. Check: the file exists with the three numbers.
- [ ] T131 OWNER-LOCAL (NFR-01, NFR-03, NFR-08, NFR-13, SC-005) Performance on the reference phone with 100,000 documents: cold start (NFR-01),
      search, statement and save (NFR-02), APK size (NFR-08), battery after one day (NFR-13). Write the
      numbers into `evidence/T131.md`.
- [ ] T132 (NFR-09, G4) Accessibility pass: every touchable in `mobile/app/**` has an accessibility label and
      ≥ 48 dp. Add an automated test walking the rendered screens and asserting the `minHeight` style.
      NFR-09. Check: the test passes.
- [ ] T133 Release workflow: extend `.github/workflows/mobile-android.yml` with a manual job `release`
      that decodes the keystore from the secret `MOTARD_UPLOAD_KEYSTORE_B64` using
      `MOTARD_UPLOAD_KEYSTORE_PASSWORD`, `MOTARD_UPLOAD_KEY_ALIAS` and `MOTARD_UPLOAD_KEY_PASSWORD`, then
      runs `./gradlew bundleRelease assembleRelease` and uploads the AAB and APK plus a `SHA256SUMS`
      file. FR-42. Check: the YAML parses, and prettier passes.
- [ ] T134 OWNER-LOCAL Release acceptance on the signed APK:
  - airplane-mode run of every Must write flow (SC-003)
  - revoke + wipe
  - version gate: install an APK built with `MONEY_RULES_VERSION` 2 and see "تحديث مطلوب"
  - the SHA-256 of the shipped APK equals the tested one

  Write the results into `evidence/T134.md`.

- [ ] T135 OWNER-LOCAL (G3, NFR-11, SC-002, SC-004, SC-006, SC-007, SC-008) Pilot (M5): at least 5 phones for 30 days. Collect SC-002 (hub inbox delivered
      without manual action, 0 duplicates), SC-004 timings, SC-006 crash-free sessions, SC-007 phone
      share of receipts, and SC-008 support issues into `evidence/pilot.md`.
- [ ] T136 Final CHECKPOINT "chore(mobile): v1 release candidate".

---

## Dependencies and order

- Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 are strictly sequential.
- Phase 7 (US1) → Phase 8 (US2) → Phase 9 (US14) → Phase 10 (US3) → Phase 11 (US15): sequential
  because they share `_layout.tsx` and the container. US3 needs US1 data and US2 sign-in.
- Tier B: Phase 12 (US4) → Phase 13 (US5, needs the party picker) → Phase 14 (US6, needs the party
  picker and the voucher form for the optional payment).
- Deferred phases depend only on Phase 6. They run in the listed order, for value.
- OWNER-LOCAL tasks never block the agent. Their results may trigger CONDITIONAL T044.
- Any GATE-D failure stops all tasks that touch `backend/`, `packages/shared/` or `src/`.

## Parallel opportunities (only where files and dependencies do not overlap)

- Phase 4: T023 and T024 together.
- Phase 6: T046 and T047 together; T056 and T057 together, after T055.
- No other tasks are marked [P]. Most later tasks edit the shared layout, the container or the same
  screens.

## Implementation strategy

1. Finish Tier A completely (T001–T086) before starting T087. Tier A is the MVP: an enrolled, synced,
   locked phone that shows today's money, with the hard parts proven (money vectors, version gate,
   parity suite, import boundary, APK pipeline).
2. Push at every CHECKPOINT, so a stop at any point loses no finished work.
3. In Tier B, finish each story with its checkpoint before starting the next.
4. If the credit is about to run out mid-task, run CHECKPOINT with message
   "wip(mobile): <TaskID> partial" and mark that task `- [ ]` with a note in its evidence file.

## Task counts

- Phase 1: 4
- Phase 2: 4
- Phase 3: 9
- Phase 4: 13
- Phase 5: 14, of which 3 are OWNER-LOCAL and 1 CONDITIONAL
- Phase 6: 17
- US1: 6
- US2: 5
- US14: 4
- US3: 4
- US15: 3
- Tier A closing: 3, of which 1 is OWNER-LOCAL
- **Tier A total: 86**
- US4: 6
- US5: 6
- US6: 8, of which 1 is OWNER-LOCAL
- **Tier B total: 20**
- **Deferred total: 30**, of which 3 are OWNER-LOCAL
- **All: 136**
