# Implementation Plan: Motard ERP Mobile (Android v1)

**Branch**: `feat/mobile` | **Date**: 2026-10-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-mobile-app/spec.md` (clarified 2026-10-25)

## Summary

The plan builds an Android app (React Native + Expo dev build, TypeScript strict) that is a full
sync device. It reuses the desktop's own use-cases, SQLite repositories, migrations and sync client
by importing them in place from `backend/src` and `packages/shared/src`, behind an import boundary
(Q1). Node-only dependencies are replaced at bundle time by four phone adapters:

- the SQLite connection shim
- the async context
- crypto
- secure storage

The highest-risk questions are settled first, on a real phone, by five M0 spikes (S1–S5). The
money vectors are merged before any phone money code. Backend changes are limited to BC-1, BC-2,
BC-3 (test only unless a gap shows), BC-4 (Should) and BC-5, each proven against both desktop test
suites.

Four facts found while planning change the PRD:

1. The hub's bootstrap endpoints are 501 stubs. The first download is the existing pull loop from
   cursor 0 (research R5).
2. The hub has no app-version check, so BC-2 is required (R6).
3. `SYNC_DEVICE_REVOKED` already exists, so BC-3 shrinks to a test (R7).
4. `motard_meta` is a one-row identity table, not key-value storage (data-model).

## Technical Context

**Language/Version**: TypeScript in strict mode (as in `tsconfig.json`, `backend/tsconfig.json`
and `packages/shared/tsconfig.json`). The JavaScript engine on the phone is Hermes. Node 22 for
tooling and tests (CI uses `node-version: "22"`).

**Primary Dependencies**: Expo SDK (the latest stable release at M0 start, pinned exactly in
`mobile/package.json` and recorded in research), React Native with Hermes, Expo Router, TanStack
React Query, drizzle-orm 0.45.2 (same version as `backend/package.json`), the S1 driver
(`@op-engineering/op-sqlite` first candidate, `expo-sqlite` second), `expo-secure-store`,
`expo-local-authentication`, `expo-print`, `expo-sharing`, `expo-notifications`,
`expo-background-task`, `expo-crypto`, `expo-file-system`, `expo-camera` (QR scan for
enrollment only), `expo-localization` (RTL), `expo-build-properties` (minSdkVersion 26),
`@react-native-community/netinfo`, `react-native-argon2`, `react-dom/server` (S3), and
`@testing-library/react-native` (tests).

**Storage**: SQLite encrypted with SQLCipher on the phone, with the existing desktop schema and
migrations unchanged. Secrets live in Android Keystore-backed `expo-secure-store`. The hub is
PostgreSQL (unchanged).

**Testing**:

- Vitest for phone adapters, money vectors and the sync parity suite, under Node.
- A test-only "Spikes" screen inside the test APK (enabled by `EXPO_PUBLIC_SPIKES=1`) that runs
  the money vectors on Hermes and the spikes S1, S2, S3 and S5.
- The existing backend suites on both engines for every BC change.
- Device e2e in airplane mode on the reference phone for release.

**Target Platform**: Android 8.0 (API 26) and later. Performance targets are set on Android 10 and
later, on a reference phone with 4 GB RAM. The code stays buildable for iOS; no iOS release.

**Project Type**: a mobile app in a monorepo (`mobile/`), plus small backend changes.

**Performance Goals**:

- NFR-01: cold start ≤ 2.5 s at 100,000 documents
- NFR-02: search ≤ 150 ms; first statement page ≤ 500 ms; invoice save ≤ 300 ms
- NFR-13: background sync ≤ 2% battery per day
- First-download time: measured in S5 before any target is set

**Constraints**:

- Fully offline for every Must flow except enrollment and the first download.
- Money identical to the hub's (constitution I and IV).
- No desktop file moved (Q1).
- Delivered desktops keep syncing unchanged (BC-2: an absent header is allowed).
- APK ≤ 60 MB.
- No telemetry.

**Scale/Scope**:

- 17 user stories: 12 Must, 1 Should group, 1 Could group.
- About 25 phone screens.
- More than 5 phones per company.
- Up to 100,000 documents per phone.

## Constitution Check

_GATE: must pass before Phase 0 research. Re-checked after Phase 1 design._

- **I. Money Exactness: PASS.** The phone runs the shared use-cases and `round2dp` / `round4dp`
  unchanged. Exact SQL division comes from the same `motard_*` functions, proven in S1 against
  `pg-numeric-div.test.ts`. Scaled integers are proven by S1 criterion 5.
- **II. Append-Only Ledger & Atomic Documents: PASS.** The same triggers come from the same
  migrations, and the same transaction layer (`transaction.ts`) runs over the shim. Entry-invoice
  colours and rolls are created inside the use-case transaction (FR-16); the phone never calls the
  desktop's client-side pre-creation path.
- **III. One Sync Protocol, Reused Unchanged: PASS.** The same `syncUseCases.ts`, `syncEnqueue.ts`,
  `numberBlockUseCases.ts` and `hubConfig.ts` run on the phone. The only contract additions are
  BC-1, BC-2 and BC-5, which are listed in constitution III.
- **IV. Parity: PASS by design, proven by gates.** The money vectors are merged before any phone
  money code. The sync parity suite (research R11) is a merge gate from M1 on.
- **V. Delivered Desktop Safety: PASS.** No desktop file is moved. Each BC change is proven with
  the full SQLite and PostgreSQL suites (contracts/backend-changes.md). The phone has its own
  composition root, and the import boundary is enforced by lint and by Metro.
- **VI. Offline-First, Same Roles: PASS.** Roles come from the same RBAC data. Sync runs under the
  device credential (R12). The session is permanent, and the app lock is separate.
- **VII. Device Security: PASS, depending on S1.** SQLCipher and the Keystore are used. If S1 finds
  no SQLCipher-capable driver, M0 stops (F1-b); there is no unencrypted fallback.
- **VIII. Phone-First Arabic UX: PASS.** The design rules UX-01…UX-08 come from the spec. No desktop
  screen is copied.
- **IX. Verifiable Quality: PASS.** Strict TypeScript, lint with 0 warnings, Prettier, and a named
  check per task (enforced in `/speckit-tasks`).
- **X. Precision & Risk-First: PASS.** M0 spikes come first, each with pass criteria and a named
  fallback. There are no NEEDS CLARIFICATION markers.

Re-check after Phase 1: still PASS. Two items are carried into tasks as gates:

- S1 must pass, or F1-a must be chosen, before M1 (tasks.md STOP-POINT 1 and SESSION-2 START).
- The S5 time must be accepted by the owner at the Tier A acceptance (tasks.md T086), before Tier B.

## Project Structure

### Documentation (this feature)

```text
specs/002-mobile-app/
├── spec.md
├── plan.md                  # this file
├── research.md              # R1–R13, spikes S1–S5, budget estimate
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── hub-api.md           # hub endpoints the phone calls
│   ├── backend-changes.md   # BC-1 … BC-6 with exact files and proof
│   └── mobile-ports.md      # import boundary and phone adapters
├── checklists/requirements.md
└── tasks.md                 # created by /speckit-tasks
```

### Source code (repository root)

```text
mobile/
├── app.json                      # Expo config: Android package id, SQLCipher plugin flags, RTL
├── package.json                  # exact pins; drizzle-orm 0.45.2
├── tsconfig.json                 # strict; paths to ../backend/src and ../packages/shared/src
├── metro.config.js               # watchFolders + resolveRequest mapping (contracts/mobile-ports.md)
├── eslint.config.js              # no-restricted-imports boundary, --max-warnings 0
├── app/                          # Expo Router screens (Arabic, RTL)
│   ├── _layout.tsx               # splash, lock, providers, sync chip
│   ├── enroll.tsx                # QR / typed code, first download
│   ├── login.tsx                 # PIN picker
│   ├── (tabs)/index.tsx          # Home
│   ├── (tabs)/parties/…          # list, detail, statement, form
│   ├── (tabs)/add/…              # sale, entry, receipt, payment, expense, return, order flows
│   ├── (tabs)/inventory/…        # fabrics → colours → rolls, roll detail, count
│   ├── (tabs)/more/…             # reports, cashbox, orders, sync status, profile
│   └── spikes.tsx                # M0 spike runner (dev builds only)
├── src/
│   ├── core/
│   │   ├── container.ts          # phone composition root (replaces sqliteContainer.ts)
│   │   ├── runtime.ts            # open DB, run bundled migrations, fingerprint check
│   │   ├── serialExecutor.ts     # one use-case at a time (research R3)
│   │   ├── syncLoop.ts           # schedule of FR-32 calling the shared sync client
│   │   ├── wipe.ts               # FR-40
│   │   └── spikeS2.ts            # deterministic S2 routine (tasks T050)
│   ├── platform/
│   │   ├── sqlite/BetterSqliteShim.ts
│   │   ├── asyncContext.ts
│   │   ├── nodeCrypto.ts
│   │   ├── secureStore.ts
│   │   ├── pinVerifier.ts        # Argon2id, desktop parameters
│   │   ├── logger.ts             # replaces backend config/logger.ts (Metro mapping)
│   │   └── envConfig.ts          # replaces backend config/env.ts (Metro mapping)
│   ├── print/                    # renderToStaticMarkup of src/components/print/* → expo-print
│   ├── ui/                       # design tokens from src/styles.css, components (FormField-style)
│   └── hooks/                    # React Query hooks calling core use-cases
├── native/motard_sqlite_ext.c    # only if fallback F1-a is chosen
├── scripts/compare-db.mjs        # S2/S5 table-by-table comparison
├── scripts/bundle-migrations.mjs # SQL migrations → src/core/generated/migrations.ts
├── scripts/s2-reference.mjs      # S2 reference database on Node
└── test/
        ├── helpers/nodeSqlite.ts      # Node-only test helper (better-sqlite3), never bundled
    ├── parity/                   # sync parity suite against the cert hub
    └── unit/
packages/shared/src/
├── money-vectors.json            # new: the shared vectors (R10)
└── money-vectors.test.ts         # new: Node runner
backend/  (BC changes only; files listed in contracts/backend-changes.md)
.github/workflows/mobile-android.yml   # new: APK build on GitHub runners (research R15)
scripts/parity/seed-sync-volume.mjs    # new: generated test data through /api/sync/push (research R14)
src/components/settings/HubDevicesCard.tsx, src/components/sync/EnrollmentQr.tsx  (BC-4, Should)
```

**Structure Decision**: one new top-level folder, `mobile/`. It is not added to the root
`workspaces` (`packages/*`), so desktop installs and CI stay unchanged. It reaches desktop code only
through `tsconfig` paths and Metro `watchFolders`. Two new shared files are added in
`packages/shared/src`. Backend files change only per the BC contracts.

## Milestones and ordering (risk first, then value)

**M0: Spikes and gates.** No phone feature code is written in this milestone.

1. Money vectors JSON + Node runner, merged first (R10).
2. S4 + BC-2 + BC-3 test + BC-1, all backend, proven on both suites. Only the cloud session is
   needed.
3. Mobile skeleton: Expo app, strict tsconfig, lint boundary, Metro mapping, spike screen.
4. The spike code for S1 (driver, SQLCipher, shim, functions, Argon2 timing) and S3 (PDF), plus the
   APK workflow. The first cloud session stops here (tasks.md STOP-POINT 1) and the owner runs S1, S3
   and the Hermes money vectors on the phone.

Exit criteria: S1 PASS or fallback F1-a chosen, S3 PASS or fallback F3 chosen, and both desktop suites
green. S2 (use-cases on Hermes) and S5 (first download) need the container (M1) and enrollment, so
they run on the phone at the Tier A acceptance (tasks.md T086); S2 is also proven on Node by the
parity suite from M1 on.

**M1: Core.**

- Runtime and migrations, the container, the serial executor
- Enrollment (FR-06, FR-08) and the first download (FR-07)
- The sync loop (FR-31 to FR-37)
- The version gate client side (FR-38)
- Revoke + wipe (FR-40), app lock and session (FR-01 to FR-05)
- The sync parity suite running in CI

**M2: Read.**

- Home (US3)
- Parties and statements (US4)
- Inventory browse (US10, read part)
- Reports and profit (US12)
- Sync status and notifications (US14)

**M3: Write.**

- Receipts, payments and expenses (US5)
- Sale invoice (US6)
- Entry invoice (US7)
- Returns (US8)
- Cashbox (US9)
- Roll adjust and stock count (US10, write part)
- Orders (US11)

**M4: Share and security.**

- PDF and send to customer (US13)
- Remaining lost-phone checks (US15)
- BC-5 and the in-app update check (FR-43)
- BC-4 QR (Should)

**M5: Pilot.** A signed APK and the Play internal track, at least 5 phones, 30 days, and the KPIs
SC-001 to SC-008.

## Budget and cut line

The estimate is in research R13. The build session uses Claude Sonnet 5.5 (owner decision
2026-10-25). The $100 credit buys about 700 to 1,100 agent turns. All of v1 is about 1,400 to
2,500 turns ($125 to $225 on Sonnet 5.5). The credit expires 2026-11-05 10:59 (GMT+3).

A cloud session cannot hold the reference phone. Every on-device check (S1 and S3 at STOP-POINT 1; S2 on Hermes and S5 at T086;
device e2e) is run by the owner on the phone, with the APK built by GitHub Actions (research R15,
quickstart §2). The cloud session writes the code and the Node-side tests.

Cut line: built with the $100, in this order.

- **Tier A (must fit):**
  - M0 in full: the money vectors, BC-1, BC-2, the BC-3 test, the mobile skeleton and boundary,
    and the S1–S5 spike code
  - M1 in full
  - From M2: Home (US3) and the sync status screen (US14)

  This is the riskiest work, and it produces a phone that enrolls, downloads, signs in, locks,
  shows today's money and syncs. Estimated 450 to 700 turns. It includes the GitHub Actions APK
  workflow (R15) and the sync-volume generator (R14).

- **Tier B (expected to be partly reached on Sonnet 5.5, in this order):**
  1. US4 parties and statements
  2. US5 receipts, payments and expenses
  3. US6 sale invoice

  These finish the P1 slice.

Deferred to the next credit, in this order:

1. The rest of M2: inventory read, reports
2. M3: US7, US8, US9, US10 write, US11
3. M4: US13, US15 checks, BC-5, FR-43
4. M5 pilot
5. Should: US16, BC-4
6. Could: US17

Rules that protect the budget:

- No milestone starts before the previous milestone's exit criteria pass.
- Every task carries its own check, so a red check stops the run early instead of piling up rework.
- Tasks state exact file paths, so the cold session spends no turns searching.

## Complexity Tracking

No constitution violation needs justification.

Two deliberate design choices are recorded for review:

- The serial executor (one use-case at a time) replaces Node's `AsyncLocalStorage` on Hermes. The
  ceiling is that the phone cannot run two use-cases in parallel. That is acceptable for one user
  on one phone.
- The first download replays the whole hub history through the existing pull loop. The ceiling is
  its time at 100,000 documents. It is measured in S5, and a snapshot endpoint (BC-7) needs owner
  approval.
