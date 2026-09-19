# Sync Operations Runbook

How to operate the hub-spoke sync in production. Every procedure below maps to
an implemented API; nothing here requires database access.

## Health endpoints (all tenant-scoped, JWT auth)

| Question | Call |
|---|---|
| What is pending / stuck? | `GET /api/sync/status` → `pendingCount`, `statusCounts`, `inboxStatusCounts`, `claimInventory`, `missingBlocks` |
| Which units are rejected / dead / awaiting retry? | `GET /api/sync/inbox?status=rejected,dead,received` (default exactly this) |
| What still needs pushing? | `GET /api/sync/pending` (includes lease-expired `pushing` strays) |
| What claims are outstanding, and are they live or stranded? | `GET /api/sync/claims` → each claim carries `holderStatus` (`received`/`applied` = live, `dead` = reappable) |
| Did the last run actually work? | `POST /api/sync/run` → `{pushed, failed, rejected, pull:{...}, pullError, blocksError}`. `pullError`/`blocksError` are null on success — a non-null value with zero counters means outage, not "in sync". |

## Triage: rejected units

A rejected unit's hub record (`/sync/inbox`) carries `rejectReason`,
`conflictOpId`, and `conflictDetail.conflicts[]` (with `availableKg`/
`requestedKg` **and** `availablePieces`/`requestedPieces` for quantity
conflicts — a sale that fits in kilograms can still lose on pieces — plus
`reason: "held"` when a live winner took the stock or
`reason: "insufficient-stock"` when the roll itself is short with no winner).
The losing device posts a `kind='sync'`
notification to the acting user AND reconciles locally:

- created documents (invoice/voucher/return/order/expense) are cancelled
  locally — verify the cancellation, do not re-create blindly;
- updates keep local edits flagged — re-enter against the hub-winning version;
- cancels keep local effect flagged — compare hub document state manually.

Never delete a rejected unit's local document to "clean up" — that destroys the
audit trail the reconciliation preserves.

## Triage: dead units

`dead` = exhausted its 5 materialization attempts. Read `materializeError` and
fix the root cause (usually a missing dependency that arrives on its own — in
which case NO action is needed). Delivery to dead is automatic: the device
re-pushes every accepted-but-unapplied unit until the hub reports it applied or
dead, and surfaces freshly-parked hub units as `hubDeadOps` in the run result
plus a device notification naming them. There is no "requeue dead" button by
design: dead means "needs a human decision first".

## Claims: reap stranded reservations

`POST /api/sync/claims/reap` releases ONLY claims whose holder op is `dead`
(live `received`/`applied` reservations report as `kept` and are never
touched). Run it after clearing a dead-letter backlog, then confirm via
`GET /api/sync/claims`. The call is audited server-side (tenant + user in logs).

## Hub outage

Devices keep working offline (admin/accountant roles; warehouse/viewer are
read-only offline). Outbox rows accumulate durably; `pushing` rows abandoned by
crashed runs are reclaimed automatically after the 5-minute lease. On
reconnect, auto-sync fires once plus two bounded retries (30s, 2m); a
concurrency skip reports `reason: "sync already running"` and is not an error.
If the backlog is large it drains in 50-unit batches — `pendingCount` falling
across runs is the healthy signal.

## Numbering and idempotency boundaries

- **Synced document numbering:** `document_number_blocks` is the canonical
  allocator for a provisioned device. `document_sequences` is retained for
  reconciliation/floor tracking, read-only previews, and the explicitly
  transitional master-data fallback before first provisioning. Financial
  document writes must fail when a block is unavailable; they must not silently
  switch authorities. The fallback path logs a warning and is not a collision
  guarantee until provisioning completes.
- **HTTP retries:** `Idempotency-Key` protects one HTTP method/path/tenant for
  `IDEMPOTENCY_TTL_SECONDS` (currently five minutes). It caches the response and
  prevents concurrent duplicate handlers, but is intentionally temporary.
- **Sync retries:** sync units use durable `op_id` uniqueness per tenant in the
  inbox/outbox. Replays must preserve `op_id`; this layer survives restarts and
  is independent of the HTTP cache. An HTTP key expiring does not authorize a
  new sync operation with a new `op_id`, and a sync replay does not depend on an
  HTTP cache entry.

## Desktop update with pending outbox

1. `GET /api/sync/pending` — record the count.
2. If online, `POST /api/sync/run` until `pendingCount` is 0.
3. If offline, proceed: the outbox lives in local PostgreSQL and survives the
   update. After update, compare the pending count — it must be identical.
4. Never uninstall with data-wipe options while pending units exist.

## Backup / restore

Sync tables (`sync_outbox`, `sync_inbox`, `sync_state`, `sync_devices`,
`sync_resource_claims`, `sync_tombstones`, `sync_conflicts`,
`document_number_blocks`) are durable production state, not caches. Back up and
restore them WITH the business tables, never truncate them independently:
truncating the outbox loses unsynced work, truncating the inbox re-opens applied
units to double-apply, resetting `sync_state` re-pulls history (idempotent but
wasteful), dropping claims re-opens decided conflicts.

`POST /api/backup/full` exports all of them, and `npm run db:restore`
(`backend/scripts/restore-from-backup.mjs`) restores them — the script refuses
to report success if any un-pushed unit was lost. The rules it applies, and why:

| State | Restore rule | Reason |
| --- | --- | --- |
| `sync_outbox` | verbatim, incl. `status`/`seq` | un-pushed units ARE the offline work. A restored `pending` unit may already be applied on the hub; the hub dedupes on `(tenant_id, op_id)` and materialization is idempotent, so re-sending cannot duplicate a business effect. `applied`/`rejected` units are never re-pushed. A unit restored as `pushing` is reclaimed after its 5-minute lease. |
| `sync_inbox` | verbatim, incl. `status`/`apply_attempts`/`received_seq` | the applied-op mirror that makes redelivery a no-op, plus the terminal states (`rejected`/`dead`) and the bounded-retry counter. |
| `sync_state.last_pull_seq` | restored, then **clamped** to the highest restored `received_seq` | a cursor pointing past everything this database has recorded skips operations SILENTLY; rewinding re-pulls them and the restored inbox answers them as already-applied. Use `--reset-pull-cursor` when the target hub is NOT the hub the backup came from. |
| `sync_resource_claims` | verbatim | first-write-wins reservations. Dropping them re-opens decided conflicts (duplicate stock/financial effects). A claim whose holder went `dead` after the backup is released through the operator path `POST /api/sync/claims/reap` (terminal-gated). |
| `sync_tombstones` / `sync_conflicts` | verbatim | deleted master rows must not resurrect; rejected update/cancel reconciliation must stay visible. |
| `document_number_blocks` | verbatim | the device's exclusive reserved ranges, so offline numbering continues inside its own block. `document_sequences` is restored with it and every later hub claim reports the local tip (`knownUsed`), so a newly carved range cannot overlap numbers already issued. Residual risk: a block whose unused tail was reclaimed on the hub AFTER the backup and re-carved elsewhere — the script prints blocks vs sequences so this can be checked. |
| `sync_outbox.seq`, `sync_inbox.received_seq`, `audit_logs.id`, `idempotency_keys.id` | sequences advanced past the restored maximum | restored rows do not move a sequence; without this, new rows sort BEFORE restored ones (out-of-order replay / wrong cursor) and the first audit or idempotent request after the restore fails on a duplicate primary key. |

`tenants`, `users`, `company_profiles` and `settings` are intentionally upserted,
never wiped (deleting the operator's own user row mid-restore is worse than
keeping a slightly newer row). Consequence: when such a row already exists, the
restore keeps the CURRENT row instead of the backup's.

The restore runs as the database owner / a superuser / a `BYPASSRLS` role. A role
that cannot bypass RLS but OWNS the tables is supported: the script sets
`app.current_tenant_id` for its session and says so. A role with neither
capability is refused up front (it cannot drop/recreate the `ledger_entries`
append-only trigger, so the wipe would fail halfway and leave the tenant
half-restored) — transfer ownership with
`ALTER TABLE ledger_entries OWNER TO <role>;` or use the owner. The script also
refuses to run at all when the schema is missing, and fails (exit 1) if any
un-pushed unit failed to come back.

## Device update / restore / re-registration

The canonical physical identity is the fingerprint-backed `device_registrations`
row. `sync_devices.device_registration_id` links the transport identity to that
license identity when activation exists; the hub migration backfills matching
same-tenant fingerprints. An application update must preserve `%LOCALAPPDATA%\motard-erp`
(including `secrets.dat`, `device-binding.dat`, `pgdata`, and sync state).

Before reinstall, export a full backup and copy the app-data directory while the
app is stopped. Restore the app-data directory before first launch so the DPAPI
binding and pending outbox survive. If the Windows user or machine changed,
DPAPI correctly refuses the old binding: do not delete the backup or mint a new
identity silently; perform a documented support rebind, then register the new
fingerprint and reconcile any orphaned number blocks. A reinstall that creates a
new sync id without this procedure leaves old blocks reserved and must be treated
as an operational incident, not a normal sync reset. Prefer repair over reinstall
when a backlog exists.

## Device gate (SYNC_UNKNOWN_DEVICE)

Pushes/pulls asserting an UNREGISTERED `syncDeviceId` are refused with
`403 SYNC_UNKNOWN_DEVICE` before any business logic runs. The device keeps the
units pending (nothing is judged, nothing rolls back) and surfaces
`deviceGate: true` in `/sync/run` plus an amber header badge ("الجهاز غير
مسجّل"). Fix: register the device (`POST /api/auth/sync-device` with its
`deviceId`), then drain normally. Units never loop blindly while gated.

## Number-block exhaustion

`missingBlocks` non-empty, or a create failing with the block-exhaustion
message, means: go online and `POST /api/sync/run` (refills while online).
Block sizes are product defaults (invoice 500, voucher 200, order/expense 100)
— raise a type's default only after checking hub sequence headroom.

## Number-block tip reconciliation

Devices that created documents via local fallback (before their first block,
or while the hub was unreachable) report their highest fallback-issued number
(`knownUsed`) on every hub block claim. The hub advances its own tip past it
before carving, and the device advances its local tip past the mirrored range.
Consequence: fallback numbers and hub blocks can never overlap. If a duplicate
code error ever appears after an offline stretch, check `document_sequences`
vs `document_number_blocks` for a tip inversion before assuming a bug.

## Push lanes (SYNC-16)

Pushes run on 4 lanes: lane 0 carries masters/orders/ledger/settlements/
cashbox/settings/company in recorded order (their replay needs parents
present); lanes 1–3 carry invoices/returns/vouchers/expenses hashed by
document, so same-document chains stay ordered while independent documents
drain concurrently. A slow lane never blocks the others; a stuck unit is still
bounded by the terminal contract, not by lane position.

## Failure drills (run quarterly)

`backend/scripts/test-sync-drills.mjs` proves, on real databases with
SIGKILLed servers: D1 device-kill exactly-once recovery, D2 hub-kill restart
with no dupes, D3 restored-clone hub serving reads+writes, D4 partition
visibility then convergence. A green drills run is required before any release
that touches sync, numbering, or the outbox.
