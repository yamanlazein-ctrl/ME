# Contract: Backend changes BC-1 … BC-6

Every change below follows constitution V:

- the `Postgres*` file and its `Sqlite*` twin change together
- each change keeps both desktop suites green before merge
- the suites run one at a time on the build machine

The proof commands, run in this order after each change:

1. `cd backend && npx tsc --noEmit`
2. `cd backend && npm run typecheck:sqlite`
3. `cd backend && npm run lint`
4. `cd backend && DB_ENGINE=sqlite npx vitest run --maxWorkers=2` (SQLite suite; baseline 1136
   passing on 2026-10-21)
5. `cd backend && DATABASE_URL=<erp_test DSN> npm test` (PostgreSQL suite, which runs
   `ensure-test-db` first; the DSN comes from an environment variable, never from a file)
6. `npx vitest run` (frontend and `packages/shared`)
7. `npm run lint`

The pass rule is the same failure count as the baseline recorded before the change, plus every new
test passing. The summary lines are pasted into the task's evidence. `--reporter=basic` is never
used.

## BC-1: phone number-block sizes

- Files:
  - `backend/src/application/use-cases/sync/numberBlockUseCases.ts`: lines 135 and 163 use
    `defaultBlockSize(entityType)`; line 425 reports `defaultSize`.
  - `backend/src/infrastructure/repositories/sqlite/helpers/documentNumbers.ts`, line 245
    `defaultBlockSize`.
  - Its PostgreSQL twin `backend/src/infrastructure/utils/documentNumbers.ts`, line 244.
- Change: add an optional `deviceKind: "desktop" | "phone"` input to the block-ensure path. For
  `"phone"`, the size is 100 for `invoice` and 50 for every other entity type. The refill threshold
  at line 135 uses the same size. When the input is absent, the behavior is exactly today's.
- Tests:
  - new `backend/tests/number-blocks-phone-size.test.ts`: phone claim sizes, the refill threshold,
    and desktop sizes unchanged
  - existing `backend/tests/invoice-numbering-gapless.test.ts` and
    `backend/tests/sync-invariants.test.ts` stay green on both engines

## BC-2: money-version gate on sync

- Files:
  - `packages/shared/src/precision.ts`: add `export const MONEY_RULES_VERSION = 1`.
  - New `backend/src/infrastructure/http/middleware/syncVersionGuard.middleware.ts`.
  - `backend/src/presentation/server.ts`, around line 547: add the guard to the sync guards object.
  - `backend/src/presentation/routes/sync.route.ts`: add `guards.syncVersionGuard` to `/sync/push`
    (line 1165) and `/sync/pull`. Extend the guards type at line 178.
- Behavior:
  - When the header `X-Motard-Money-Version` is present and its value differs from
    `MONEY_RULES_VERSION`, the guard answers
    `426 { code: "SYNC_VERSION_MISMATCH", message: "تحديث مطلوب", hubVersion, clientVersion }`.
  - When the header is absent, the request passes, so delivered desktops are unaffected.
- Tests: new `backend/tests/sync-version-gate.test.ts`, covering:
  - matching header → 200
  - different header → 426
  - absent header → 200

  It runs on both engines.

## BC-3: revoked reason reaches the phone (verification first)

- Fact: `SYNC_DEVICE_REVOKED` exists (`auth.route.ts` line 692; `syncEnrollment.ts` lines 236 and
  257).
- Test: new `backend/tests/sync-revoked-device-codes.test.ts`. It asserts that a revoked device gets
  `403 SYNC_DEVICE_REVOKED` on push, on pull and on token refresh through `/api/sync/device-token`.
- Code change: only for a path the test shows is missing, made in that path's route file. It stays
  a test-only change if all three already pass.

## BC-4: enrollment code as QR on the desktop (Should)

- Files:
  - `src/components/settings/HubDevicesCard.tsx`: where the enrollment code is created and shown (rendered by `src/routes/settings.sync.tsx`).
  - New `src/components/sync/EnrollmentQr.tsx`.
  - Root `package.json`: add one QR dependency. The repository has none today, checked 2026-10-25.
- Behavior: the QR encodes `{ "hub": <hub URL>, "code": <enrollment code> }` as JSON. The text code
  stays visible.
- Tests:
  - new `src/components/sync/__tests__/EnrollmentQr.test.tsx`: the QR payload is decoded back to
    the same JSON
  - `npm run lint` and `npx vitest run` green

## BC-5: version manifest for the direct-APK channel

- Files:
  - new `backend/src/presentation/routes/mobileVersion.route.ts`
  - registered in `backend/src/presentation/server.ts` next to the health routes
- Behavior: `GET /api/mobile/version` returns
  `{ minVersionCode, latestVersionCode, latestVersionName, apkUrl, apkSha256, moneyRulesVersion }`,
  without authentication. Values come from the environment variables `MOBILE_MIN_VERSION_CODE`,
  `MOBILE_LATEST_VERSION_CODE`, `MOBILE_LATEST_VERSION_NAME`, `MOBILE_APK_URL` and
  `MOBILE_APK_SHA256`. `moneyRulesVersion` comes from `MONEY_RULES_VERSION`. When the variables are
  unset, the route answers `404 MOBILE_VERSION_NOT_CONFIGURED`.
- Tests: new `backend/tests/mobile-version-route.test.ts`, for the configured and unconfigured
  cases.

## BC-6: `packages/core` extraction

Deferred until after the pilot (Clarifications, Q1). Not built in v1.
