# Research: Motard ERP Mobile (Android v1)

Feature: `specs/002-mobile-app/spec.md` · Constitution v2.0.0 · Date: 2026-10-25

Every fact below was taken from the project brain (`C:\Users\Taw\Downloads\Brain\Project\Motard ERP`)
and confirmed in the repository with targeted lookups. File paths are repository-relative. Where a
fact can only be settled on a real phone, it is assigned to an M0 spike with a pass/fail rule and a
named fallback.

## R1. How the phone reuses desktop code (Q1, decided)

Decision: the phone imports the desktop's business and sync code in place from `backend/src` and
`packages/shared/src`. No desktop file is moved in v1. An ESLint import boundary in `mobile/` fails
the build when anything the phone bundles reaches a server-only module.

Facts that shape this:

- Use-cases live in `backend/src/application/use-cases/<module>/` (cashbox, dashboard, expenses,
  inventory, invoices, ledger, orders, parties, printing, profit, returns, settings, statements,
  sync, vouchers, and others that are not used on the phone).
- SQLite repositories live in `backend/src/infrastructure/repositories/sqlite/` (47 files). They are
  wired by `backend/src/infrastructure/di/sqliteContainer.ts` (204 lines). That container also
  pulls server-only parts: `JwtSigner`, `Argon2PasswordHasher` (native Node addon),
  `AesGcmSecretStore`, `NodeFingerprintProvider`, `SelfHostedLicenseProvider` and
  `config/env.js`. The phone therefore gets its own composition root,
  `mobile/src/core/container.ts`, which wires only the repositories and use-cases in scope (§5 of
  the spec) and supplies phone adapters for the ports.
- Node built-ins reached from the code the phone needs (counted with grep on 2026-10-25):
  - `node:crypto` in 15 imports — calls used: `randomUUID` ×12, `createHash` ×4, `randomBytes` ×4,
    `timingSafeEqual` ×1
  - `node:async_hooks` in 2 imports
  - `node:fs` and `node:path` in 3 each
  - `node:url`, `node:os` and `node:net` in 1 each

  The files involved are listed in the boundary contract `contracts/mobile-ports.md`.

- The existing precedent for an import boundary is the backend `pg` rule in
  `backend/eslint.config.js` (`no-restricted-imports`, decision D-006).

How the boundary is enforced: `mobile/eslint.config.js` sets `no-restricted-imports` for `node:*`,
`fs`, `path`, `os`, `net`, `child_process`, `express`, `pg`, `better-sqlite3`, `argon2`,
`googleapis`. A Metro resolver rule in `mobile/metro.config.js` maps each permitted Node built-in
(crypto, async_hooks) to a phone adapter and throws at bundle time for any other one. So a
transitive import that lint cannot see still fails the build.

Alternative rejected for v1: extracting `packages/core` (BC-6). It moves delivered desktop files
before the pilot (constitution V). It is deferred until after the pilot.

## R2. SQLite engine on the phone (spike S1)

What the desktop engine needs, from the code:

- `backend/src/infrastructure/orm/sqlite/connection.ts` opens two better-sqlite3 connections (a
  writer and a read-only reader) and asserts pragmas through `db.pragma()`.
- `backend/src/infrastructure/orm/sqlite/transaction.ts` runs its own `BEGIN IMMEDIATE` / `COMMIT`
  / `SAVEPOINT` with a FIFO write gate, because better-sqlite3 is synchronous and the shared code
  awaits inside `withTenantTx`.
- `backend/src/infrastructure/orm/sqlite/exactIntegers.ts` runs every statement in safe-integer
  mode: integers beyond ±2^53 come back as `bigint`. Money is stored as scaled integers
  (`numericFunctions.ts` header).
- `backend/src/infrastructure/orm/sqlite/numericFunctions.ts` registers app SQL functions with
  `db.function(...)` and an aggregate:
  - `motard_pgdiv`
  - `motard_dectext`
  - `motard_decsum` (aggregate)
  - `motard_re_substr`
  - `motard_re_match`

  They are used only in queries, not in the schema. The callers are
  `repositories/sqlite/helpers/likeContains.ts` (search, used by many repositories),
  `SqliteDashboardRepository.ts` and `SqliteDocumentTrackRepository.ts`.

- Drizzle 0.45.2 (`backend/package.json`) through `drizzle-orm/better-sqlite3`. The repositories
  `await` Drizzle queries; `transaction.ts`, `sequences.ts` and `queryable.ts` call
  `prepare().run/get/all` directly.

The phone needs a connection object that behaves like the parts of better-sqlite3 these files use:
`prepare(sql).run/get/all/iterate`, `pragma`, `function`, `aggregate`, `safeIntegers`, `exec`,
`transaction`. The spike builds that adapter, `mobile/src/platform/sqlite/BetterSqliteShim.ts`,
over one native driver.

Candidate driver: `@op-engineering/op-sqlite`. It has synchronous execution, a SQLCipher build flag
and native extension loading. Second candidate: `expo-sqlite`, which has a synchronous API and a
SQLCipher config option.

S1 pass criteria (all must hold on the reference phone, a mid-range Android with 4 GB RAM and
Android 10 or later):

1. The database opens encrypted with SQLCipher. The raw file read with `sqlite3` without the key
   fails to parse.
2. Every SQLite migration in `backend/src/infrastructure/orm/sqlite/migrations/` (10 files) applies
   in order, and the schema fingerprint check in
   `backend/src/infrastructure/orm/sqlite/schemaFingerprint.ts` returns the same fingerprint as
   on the desktop.
3. Synchronous `prepare().run/get/all` work inside an explicit `BEGIN IMMEDIATE` … `COMMIT`.
4. The five `motard_*` functions return byte-identical results to the desktop for every case in
   `backend/tests/sqlite/pg-numeric-div.test.ts` and `backend/tests/sqlite/like-contains.test.ts`.
5. A scaled integer of 9,007,199,254,740,993 round-trips exactly (it comes back as `bigint`).
6. The pragmas asserted in `connection.ts` hold: WAL journal, `synchronous` not OFF, foreign keys
   ON.

S1 fallbacks, in order:

- **F1-a:** if the driver cannot register JS SQL functions, compile the five functions as a C
  SQLite extension (`mobile/native/motard_sqlite_ext.c`) that ports `numericFunctions.ts`
  exactly. Load it through the driver's extension loading, and pass criterion 4 against the same
  cases.
- **F1-b:** if neither candidate supports SQLCipher plus synchronous calls, stop M0 and return to
  the owner with measured results. No silent switch to an unencrypted database (constitution VII).

## R3. Async context on Hermes (spike S2)

`node:async_hooks` `AsyncLocalStorage` is used by:

- `backend/src/infrastructure/orm/tenant-context.ts`
- `backend/src/infrastructure/orm/ambient-tx.ts`
- `backend/src/infrastructure/orm/sqlite/transaction.ts`
- `backend/src/infrastructure/orm/sqlite/clock.ts`
- `backend/src/infrastructure/http/middleware/tenant.middleware.ts` (not bundled on the phone)
- `backend/src/application/use-cases/sync/syncConflicts.ts`

Hermes does not provide `AsyncLocalStorage`.

Decision: the phone runs every use-case call through one serial executor,
`mobile/src/core/serialExecutor.ts`. Exactly one use-case runs at a time, from start to finish. A
stack-based `AsyncLocalStorage` replacement, `mobile/src/platform/asyncContext.ts`, exports the
same `run` / `getStore` API and is mapped in by Metro for `node:async_hooks`. Because nothing
interleaves, a module-level stack gives the same answer as Node's async context.

S2 pass criteria:

1. Metro bundles `mobile/` with the receipt, sale invoice and sync use-cases imported from
   `backend/src`, with 0 boundary errors.
2. On Hermes, the receipt use-case and a 3-line sale invoice use-case run against the S1 database
   and write the same rows as the desktop for the same inputs (compared row by row with the
   desktop's SQLite file).
3. A nested `withTenantTx` inside a use-case becomes a SAVEPOINT, as on the desktop.
4. Two use-cases started at the same time run one after the other, never interleaved (proven by
   ordered log markers).

S2 fallback F2: if a use-case path depends on real concurrent async context (two flows in flight
inside one transaction), that path gets a phone-side wrapper in `mobile/src/core/` that calls the
same repository functions in the same order. It needs a parity test before use. No business rule
is rewritten.

## R4. Node crypto on the phone

The calls used are `randomUUID`, `createHash('sha256')`, `randomBytes` and `timingSafeEqual`.

Decision: `mobile/src/platform/nodeCrypto.ts` implements exactly these four with `expo-crypto`
(UUID, SHA-256, random bytes) and a constant-time compare written in TypeScript. Metro maps
`node:crypto` to it. Any other `node:crypto` export is absent, so a new caller fails at bundle
time.

## R5. First download = full pull from cursor 0

Fact: `/sync/bootstrap` and `/sync/snapshot-watermark` are stubs. They answer
`501 SYNC_BOOTSTRAP_NOT_ENABLED` / `SYNC_WATERMARK_NOT_ENABLED`
(`backend/src/presentation/routes/syncBootstrap.route.ts`, design REPAIR-029). PRD §11.1 listed
them as usable; that is corrected here.

How a new device really gets data: `GET /api/sync/pull?afterSeq=<n>&limit=<1..100>`
(`backend/src/presentation/routes/sync.route.ts` around line 1262). It returns `items[]` (with
`receivedSeq` = the applied order), `hubEpoch` and `headSeq`. The device materializes each page
and stores the last `receivedSeq` as its cursor.

Decision for FR-07:

- The first download is the existing pull loop from `afterSeq=0` with `limit=100`.
- Progress = last applied seq ÷ `headSeq` shown as a percentage, plus the count of units applied.
- Resume = the stored cursor.

No new hub endpoint is needed.

Spike S5 (added; first-download time and completeness):

1. On the cert test hub seeded with generated data (R14; no customer data is used), the phone's record counts and every party balance equal the desktop's after the
   first download.
2. Time to download and apply 100,000 documents on the reference phone over Wi-Fi is measured and
   recorded. Pass: it finishes and resumes correctly after a forced kill at 40%. The measured time
   is written into NFR evidence; no target is set until it is measured.

Fallback F5: if the time is unusable (the owner judges it after seeing the number), BC-7 (a real
snapshot endpoint, REPAIR-029) is proposed to the owner as a separate decision. It is not built in
v1 without approval.

## R6. Version gate (spike S4 → BC-2)

Fact (checked 2026-10-25): `sync.route.ts` and `application/use-cases/sync/syncUseCases.ts` do not
check the app version on push or pull. The word "version" there refers only to row base versions,
`deviceFingerprintVersion` and `localDataVersion`.

S4 pass criterion: a test against a disposable hub shows that a push carrying any app-version
header is accepted today. This proves the gate is absent and BC-2 is needed.

BC-2 design (contract in `contracts/backend-changes.md`):

- New constant `MONEY_RULES_VERSION` (integer, starts at 1) in `packages/shared/src/precision.ts`,
  bumped whenever rounding or money storage rules change.
- Every phone request to `/api/sync/push` and `/api/sync/pull` carries the header
  `X-Motard-Money-Version: <n>`.
- A new middleware, `syncVersionGuard` (`backend/src/infrastructure/http/middleware/syncVersionGuard.middleware.ts`), added to the guards passed in
  `backend/src/presentation/server.ts` (next to `transportGuard`, around line 547). When the header
  is present and differs from the hub's constant, it answers
  `426 { code: "SYNC_VERSION_MISMATCH", hubVersion, clientVersion }`.
- When the header is absent (every delivered desktop up to 3.0.7), the request is allowed, so
  delivered desktops keep syncing. Owner decision 2026-10-25: absent-header devices stay allowed
  until every desktop runs a release that sends the header; refusing them then is a separate,
  later change that needs the owner's go-ahead.

## R7. Revoked device (BC-3 reduced)

Fact: the hub already returns `403` with code `SYNC_DEVICE_REVOKED` (`auth.route.ts` line 692;
`syncEnrollment.ts` lines 236 and 257; port note in `application/ports/ISyncDeviceRepository.ts`
line 58). Revoke and reinstate exist at `POST /sync/devices/:deviceId/revoke` and `/reinstate`
(`sync.route.ts` lines 1555 and 1590).

Decision: BC-3 becomes verification only. A backend test asserts that push, pull and token refresh
each return `SYNC_DEVICE_REVOKED` for a revoked device. Code is added only if one of the three does
not.

## R8. PDF from the desktop print layouts (spike S3)

Fact: the print layouts are React DOM components in `src/components/print/`:

- `InvoicePrintDocument.tsx`
- `PartyStatementDocument.tsx`
- `SettlementPrintDocument.tsx`
- `PrintDocument.tsx` (337 lines)
- `PrintMoney.tsx`

They are not HTML templates.

Decision: the phone renders the same components to an HTML string with `react-dom/server`
`renderToStaticMarkup`, inlines the print CSS, and passes it to `expo-print` `printToFileAsync`.
The Arabic font file is embedded as a base64 `@font-face`.

S3 pass criteria:

1. A 3-line invoice and a 650-row statement render to PDF on the reference phone.
2. The Arabic text is shaped correctly and right-to-left, and amounts and currencies equal the
   desktop print of the same documents, compared visually page by page by the owner.
3. The 650-row statement renders in under 10 seconds.

S3 fallback F3: hand-written HTML templates in `mobile/src/print/` reproduce the desktop layout,
compared page by page with the desktop print by the owner.

## R9. Offline PIN check

Fact: passwords and PINs are Argon2id (64 MiB / t=3 / p=4, decision D-005), on the hub through the
`argon2` Node addon (`backend/src/infrastructure/auth/PasswordHasher.ts`). There is no Argon2 in
JavaScript on the phone.

Decision: `react-native-argon2` (a native module) computes the local verifier at the desktop's
parameters. S1 also measures it.

- Pass: one verify takes 1.5 seconds or less on the reference phone.
- Fallback F9: if the time is over 1.5 seconds, keep the desktop parameters (no weakening, per
  D-005) and show a progress indicator during offline PIN sign-in.

## R10. Money vectors (constitution IV, built first)

Existing money tests:

- `packages/shared/src/precision.test.ts`
- `backend/tests/money-precision.test.ts`
- `src/shared/utils/__tests__/precision.test.ts`
- `backend/tests/sqlite/pg-numeric-div.test.ts`
- `backend/tests/invoice-total-parity.test.ts`

They run on Node only.

Decision: one versioned data file, `packages/shared/src/money-vectors.json`. It holds input,
operation and expected-output cases for `round2dp`, `round4dp`, the invoice line and total
formula, and the SYP/USD conversion. It is seeded from the five files above, plus edge cases
(.005 halves, negatives, 9,007,199,254,740,993, rates with 4 decimals).

Two runners read it:

- `packages/shared/src/money-vectors.test.ts` (Vitest, Node)
- `mobile/test/money-vectors.hermes.test.ts` (runs on Hermes through the Expo dev client test
  harness)

The vectors and the Node runner are merged before any mobile money code. The Hermes runner is part
of S2.

## R11. Sync parity suite

Existing sync test base: `backend/tests/sync-*.test.ts` (claims, idempotency, pull cursor,
conflicts, dead units, coverage, invariants) and `backend/scripts/test-sync-drills.mjs` (drills D1
to D4).

Decision: `mobile/test/parity/` drives a disposable test hub through the existing cert stack
(`tests/e2e/cert-stack.mjs` starts an `erp_cert` PostgreSQL database and a backend on `:18080`).
It runs the phone core under Node with the S1 shim's Node backend (better-sqlite3), plus a desktop
SQLite instance. Scenarios:

- a receipt
- a 3-line sale
- a sale cancel
- a voucher replace
- the claim race between two devices
- fallback numbering after block exhaustion
- an epoch change

After each scenario, every business table is compared field by field across phone, desktop and
hub. The same scenarios run once per milestone on the reference phone against the same hub.

## R12. Hub sync rights

Fact: `transportGuard` = `rbac(["admin", "accountant"])` (`server.ts` line 547) on `/sync/push` and
`/sync/pull`. The desktop syncs with its device credential (`hubConfig.ts` posts to
`/api/sync/device-token`), not with the signed-in user.

Decision: the phone does the same. Sync runs under the device credential obtained at enrollment,
so a warehouse or viewer user signed in on the phone still syncs. Their role limits only local
writes (FR-05).

## R13. Budget estimate for the cloud build (honest, with assumptions)

Prices (Anthropic first-party, cached 2026-10-06):

- Claude Opus 5.5: $4 per million input tokens, $20 per million output tokens, $0.20 per million
  cache-read tokens.
- Claude Sonnet 5.5: $2 per million input tokens, $10 per million output tokens, $0.20 per million
  cache-read tokens.

Assumption: the $100 cloud credit is charged at these token rates. If it is charged differently,
the turn counts below scale with the real rate.

Model of one agent turn in a long build session:

- about 120,000 tokens of context read from cache: $0.024 on either model
- about 5,000 new input tokens: $0.02 to $0.03, cache writes included
- about 4,000 output tokens including thinking: $0.08 on Opus, $0.04 on Sonnet

That is about $0.13 per Opus turn and $0.09 per Sonnet turn, uncertain by ±50%. $100 is therefore
about 500 to 1,100 turns.

Size of the whole v1 build, from the plan's task groups:

- about 170 tasks
- 8 to 15 turns each, including tests and fixes
- 1,400 to 2,500 turns in total
- about $180 to $330 on Opus 5.5, or $125 to $225 on Sonnet 5.5

Owner decision 2026-10-25: the build session uses Claude Sonnet 5.5. At about $0.09 per turn the
$100 credit buys about 700 to 1,100 turns, which covers roughly 30% to 55% of v1. The cut line in
`plan.md` follows from this.

The credit expires 2026-11-05 10:59 (GMT+3), 11 days after this plan. Wall-clock time is a second
limit, because spikes S1, S3 and S5 need the reference phone in the owner's hands.

## R14. Test data (no customer data)

Owner decision 2026-10-25: no customer data is used. Generated data only.

- Existing generator `scripts/parity/seed-volume.mjs` (specs/001 task T025) creates one tenant
  with N parties (80% customers, 20% suppliers, one "deep" customer holding 20% of invoices), N sale
  invoices over four years, and one receipt per invoice, at 10k / 50k / 100k. It writes straight
  into hub tables, so its data is NOT in `sync_inbox` and a phone cannot pull it. It is used for
  hub-side read baselines only.
- New generator `scripts/parity/seed-sync-volume.mjs` (planned): same shape and flags
  (`--invoices`, `--parties`), but every party, invoice and receipt is sent as a sync unit through
  the hub's real `POST /api/sync/push` by an enrolled test device against the cert stack. Each unit
  is materialized by the hub, so the data is in the pull stream for S5. It writes a completeness
  file (record counts and per-party balances) for the phone to compare against.
  Its own check: after seeding 1,000 invoices, `GET /api/sync/status` shows 0 pending and the hub's
  party balances equal the completeness file.

## R15. Building the APK without a local Android SDK or EAS

Fact (owner, 2026-10-25): the owner has neither the Android SDK nor an Expo (EAS) account.

Decision: a GitHub Actions workflow, `.github/workflows/mobile-android.yml`, builds the dev-client
APK (debug) on GitHub's Ubuntu runners, which include the Android SDK. It runs on push to
`feat/mobile` when `mobile/**` changes, and on manual dispatch. Steps: Node 22, JDK 17,
`npm ci` in `mobile/`, `npx expo prebuild --platform android`, `./gradlew assembleDebug`, upload
the APK as a workflow artifact. The owner downloads the APK from the run page and installs it on
the reference phone. Cost: about 15 to 25 runner minutes per build, from the account's Actions
minutes. Release builds (M5) use the same workflow with the signing secrets stored as GitHub
encrypted secrets.
