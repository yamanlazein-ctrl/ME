# Quickstart: Motard ERP Mobile (Android v1)

How to build, test and verify the phone app once `mobile/` exists. Commands are run from the
repository root on branch `feat/mobile`, unless a step says otherwise. Secrets (hub DSN, signing
key passwords) come from environment variables and are never written into files.

## 0. Before any change: record the desktop baseline

Run each suite one at a time (machine RAM is about 7.7 GB). Paste each summary line into the task
evidence.

1. `cd backend && DB_ENGINE=sqlite npx vitest run --maxWorkers=2`. The baseline on 2026-10-21 was
   1136 passing.
2. `cd backend && DATABASE_URL=$ERP_TEST_DSN npm test`. Use PostgreSQL from
   `tools/postgres-test/resources-postgres/bin` on port 56437. Ports 55372–55471 are excluded on
   this machine.
3. `npx vitest run`
4. `npm run lint`
5. `cd backend && npm run lint`
6. `cd backend && npm run typecheck:sqlite`

## 1. Money vectors (first code merged)

1. `npx vitest run packages/shared/src/money-vectors.test.ts`. It must report every vector passing.
2. On the phone (tasks.md T041), press "Money vectors (Hermes)" on the Spikes screen of the test APK.
   It must report the same count, with 0 failures.

## 2. Build the Android dev client

Expo Go cannot load the native SQLCipher and Argon2 modules. A dev client build is required.

Option C, GitHub Actions (the owner's path: no local Android SDK and no Expo account):

1. Push to `feat/mobile`, or open Actions → "mobile-android" → Run workflow.
2. When the run finishes, download the `motard-mobile-test-apk` artifact from the run page. It is a release-variant APK with
   the JavaScript bundled inside, signed with the Expo template debug key, so no computer is needed.
3. Copy the APK to the phone and install it (allow installs from this source once).

Option A, local (needs the Android SDK and JDK 17 on the machine):

1. `cd mobile && npm install`
2. `cd mobile && npx expo prebuild --platform android`
3. `cd mobile && npx expo run:android --variant debug` (with the phone connected over USB and USB
   debugging on)

Option B, EAS cloud build (needs an Expo account):

1. `cd mobile && npx eas build --profile development --platform android`
2. Install the APK from the link EAS prints.

## 3. M0 spikes on the reference phone

The reference phone is a mid-range Android with 4 GB RAM and Android 10 or later.

- S1 (database): open the dev client's "Spikes" screen and run "S1 SQLite". It prints PASS or FAIL
  for each of the six criteria in research R2, and the Argon2 verify time (R9).
- S2 (shared code on Hermes): run "S2 use-cases". It writes a receipt and a 3-line sale. Export the
  phone database with the screen's "Export for comparison" action, then on the computer run
  `node mobile/scripts/compare-db.mjs <phone.db> <desktop.db>`. It must print `0 differences`.
- S3 (PDF): run "S3 PDF". Open the two PDFs it shares and compare them with the desktop prints of
  the same documents.
- S4 (version gate): run on the computer, against a disposable hub:
  `cd backend && npx vitest run tests/sync-version-gate.test.ts`. Before BC-2 the "different header
  → 426" case fails, which proves the gate is absent. After BC-2 all cases pass.
- S5 (first download): seed the cert hub with generated data
  (`node scripts/parity/seed-sync-volume.mjs --invoices 100000 --parties 10000`, research R14), then run "S5 First
  download" on the phone. It reports record counts, party balance differences (must be 0), the
  elapsed time, and the resume result after the forced kill at 40%.

## 4. Mobile checks (every merge)

1. `cd mobile && npx tsc --noEmit` (strict)
2. `cd mobile && npx eslint . --max-warnings 0`. This includes the import boundary.
3. `cd mobile && npx vitest run`. These are unit tests of the phone adapters, run under Node.
4. `npx prettier --check mobile specs/002-mobile-app`
5. `cd mobile && npx vitest run test/parity`. This is the sync parity suite. It needs the cert stack
   (`node tests/e2e/cert-stack.mjs`, PostgreSQL on 56437, `E2E_ADMIN_PASSWORD` set,
   `E2E_TELEMETRY_DISABLED=1`).
6. When shared code changed, run the full step 0 again.

## 5. Release build (M5)

1. The owner sets `MOTARD_UPLOAD_KEYSTORE`, `MOTARD_UPLOAD_KEYSTORE_PASSWORD`,
   `MOTARD_UPLOAD_KEY_ALIAS` and `MOTARD_UPLOAD_KEY_PASSWORD`. The same key is registered with Play
   App Signing (FR-42).
2. `cd mobile && npx expo prebuild --platform android --clean`
3. `cd mobile/android && ./gradlew bundleRelease assembleRelease`. This produces the AAB for Play
   and the APK for direct download.
4. Record the APK SHA-256. The airplane-mode device e2e, revoke + wipe and version-gate checks run
   on this exact APK. The shipped APK must have the same SHA-256.
