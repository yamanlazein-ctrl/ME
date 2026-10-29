# Contract: Hub endpoints the phone calls

These are existing endpoints on the hub (Express on Render, PostgreSQL). Their request and response
shapes are those in the repository. The phone sends exactly what the desktop sync client sends
(`backend/src/application/use-cases/sync/syncUseCases.ts`, `hubConfig.ts`), because it runs that
same client code (research R1). The only addition is the header in BC-2.

Common to every call:

- Base URL: the hub URL received at enrollment.
- Authentication: `Authorization: Bearer <access token>`. Sync calls use the device credential's
  token, as the desktop does (research R12).
- Money version: `X-Motard-Money-Version: <MONEY_RULES_VERSION>` on `/api/sync/push` and
  `/api/sync/pull` (BC-2).
- Errors the phone must handle by code:
  - `401` on refresh → end the session (FR-03)
  - `403 SYNC_DEVICE_REVOKED` → wipe (FR-40)
  - `403 SYNC_UNKNOWN_DEVICE` → units stay pending; show "register device"
  - `426 SYNC_VERSION_MISMATCH` → update required (FR-38)
  - `428` → missing `Idempotency-Key` on a financial HTTP POST; this is a bug, never shown to the
    user

## Enrollment and identity

- `POST /api/sync/enroll`: exchanges an enrollment code for device registration
  (`backend/src/presentation/routes/syncEnrollment.route.ts`).
- Enrollment QR (shown by the desktop in `HubDevicesCard`, parsed by the phone): text
  `motard-enroll://v1?u=<hub url>&c=<code>`; the phone fills the hub URL and code from it and calls
  `POST /api/sync/enroll`. Reference parser: `src/components/settings/enrollQr.ts`.
- `POST /api/sync/device-token`: device credential → tokens (called by `hubConfig.ts` line 272).
- `POST /api/auth/sync-device`: registers a sync device.
- `GET /api/auth/device-roster`: the users authorized on this device, for the PIN picker.
- `POST /api/auth/pin-login`, `POST /api/auth/login` (fallback), `POST /api/auth/set-pin`.
- `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/auth/me`.

## Sync

- `POST /api/sync/push`: one unit per request, validated by `PushUnitSchema`. Body fields include
  `opId`, `syncDeviceId`, `entityType`, `entityId`, `operation` and payload. Response
  `{ accepted: true, opId, … }` or `{ accepted: false, opId, … }` with the rejection reason. Guarded
  by `transportGuard` (`rbac(["admin","accountant"])`) plus the device attribution gate.
- `GET /api/sync/pull?afterSeq=<n>&limit=<1..100>` (default limit 50, maximum 100). Response:
  - `items[]`, each with `opId`, `syncDeviceId`, `entityType`, `entityId`, `operation`, `payload`,
    `receivedSeq` (the cursor value), `appliedSeq`, `receivedAt`, `appliedAt`
  - `hubEpoch`
  - `headSeq`

  The phone's first download is this loop from `afterSeq=0` with `limit=100` (research R5).
  Progress = cursor ÷ `headSeq`.

- Number blocks:
  - `POST /api/sync/number-blocks/claim` (accepts `size`)
  - `/ensure`
  - `/tip`
  - `/reclaim`
  - `GET /api/sync/number-blocks`
- Health:
  - `GET /api/sync/status` (`pendingCount`, `statusCounts`, `missingBlocks`)
  - `GET /api/sync/pending`
  - `GET /api/sync/inbox?status=rejected,dead`

## Other

- `GET /api/fx/reference-rate`: pre-fills the exchange rate when online (FR-19).
- `GET /api/health/live`: reachability check (`hubConfig.ts` line 408).
- `GET /api/mobile/version` (new, BC-5): `{ minVersionCode, latestVersionCode, latestVersionName,
apkUrl, apkSha256, moneyRulesVersion }`.

## Not used by the phone

- `/sync/bootstrap` and `/sync/snapshot-watermark` return `501` (stubs, REPAIR-029).
- All hub-side admin routes, backup, Drive, licence, setup and year-closing routes.
