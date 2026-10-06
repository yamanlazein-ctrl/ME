# US5 — Sync on SQLite desktops (T102–T110)

Date: 2026-10-04. Branch `clean-desktop-release` (uncommitted working tree).
Hub: unchanged cloud code path (non-desktop, PostgreSQL 17 throwaway cluster on 55432), fresh tenant per run.
Harness: `scripts/parity/lib/syncAc8.mjs`. Desktops run on the engine under test, and a recording proxy per desktop
sits in front of the hub.

## Scenario (AC-8, quickstart §6)

1. **Online.** A and B reserve number blocks. A creates 3 customers, a fabric, a color, 6 rolls of 500 kg and a shared
   roll RS of 100 kg. A pushes and B pulls.
2. **Offline.**
   - A creates 20 sale invoices; the last one takes 30 kg of RS.
   - B creates 30; the last one also takes 30 kg of RS.
   - Both edit customer C0's phone (the same-record edit).
3. **Reconnect.** A, B, A, B each sync until drained.
4. **Conflict.** The hub has opened one conflict for B's edit. An operator resolves it with `keep-server`, then B, A
   and B sync again.

## T103 — golden wire test: **PASS**

`node scripts/parity/sync-wire.mjs` → `[parity:diff] PASS — empty diff across 162 file(s)`.

The PostgreSQL-desktop and SQLite-desktop runs produce identical results under the contracts/sync-wire-compat.md
canonicalization, across:

- all 132 device↔hub exchanges, in order: number blocks, every push batch, every pull page, conflict responses, with
  request and response bodies;
- the scenario log (every `/sync/run` result, the conflict resolution, the final `/sync/status`);
- the hub's conflict list;
- **every table** of the hub, device A and device B after convergence.

Two exclusions, both timing that occurs on either engine:

- `GET /api/health/live`: the TTL-cached hub reachability probe, which fires on wall-clock age;
- the order of device-local `notifications` rows: tables are read without ORDER BY, so they are compared as a
  multiset.

Fixed along the way (real engine difference): the device-local `sync_inbox.applied_seq` started at **1** on SQLite but
at **2** on PostgreSQL, because migration 20261016 runs `setval('sync_inbox_applied_seq', GREATEST(max(received_seq), 1))`.
The SQLite baseline now seeds `motard_sequences('sync_inbox_applied_seq', 1)`, and the generator is updated too
(`generate-sqlite-baseline.mjs --check` passes).

## T102 — A = B = hub convergence: harness done; **7/9 checks, same result on both engines**

`node backend/scripts/verify-sync-multidevice.mjs --ac8 --device-engine sqlite` (or `postgres`):

| Check | SQLite desktops | PostgreSQL desktops |
|---|---|---|
| hub / A / B hold 50 invoices | PASS | PASS |
| identical invoice numbers on A, B, hub | PASS | PASS |
| A and B outboxes drained | PASS | PASS |
| one hub conflict for the same-record edit, resolved keep-server | PASS | PASS |
| A business state identical to the hub | **FAIL** | **FAIL** (same rows) |
| B business state identical to the hub | **FAIL** | **FAIL** (same rows) |

The comparison covers every business table:

- device-local tables are excluded: sync transport, number blocks and counters, audit, notifications, identity and
  licensing, and request idempotency (`financial_operations`);
- `created_at`/`updated_at` and `client_operation_id` are excluded;
- derived rows (invoice lines, ledger legs, stock movements) get node-minted ids, so they are compared by content.

The failures are **engine-independent behaviors of the shared sync code**. They are identical with PostgreSQL
desktops, so they are not caused by SQLite. They need an owner decision (constitution: no cloud/hub behavior change in
this feature):

1. **Roll creation stock movements are not synced.** On device A, creating a roll writes an `initial` stock movement
   (7 rows). The hub and B materialize the roll but never write that movement. Roll quantities agree everywhere; the
   stock card history does not.
2. **The losing device keeps its own edit after `keep-server`.** B's C0 update is marked `rejected` in B's outbox, but
   B's local party row is not rolled back to the server version. B shows phone `0922-000-B`, while the hub and A show
   `0911-000-A`.
3. **`stock_movements.balance_after_kg` depends on application order.** On the shared roll, each node stores the
   running balance in the order it applied the two sales (its own first). Final roll quantities agree, but the
   per-movement snapshot differs between nodes.

## T105 / T108

Recorded in research.md §R13a:

- **I-9:** the desktop pull mirrors every unit into its local `sync_inbox` (T7 trigger required on the desktop).
- **I-12:** acknowledged units are identified by `op_id` (the hub's `sync_inbox` is unique on `(tenant_id, op_id)`; a
  re-push is answered `accepted/terminal` with no second effect).
- **I-5 for sync:** no payload-text hashing, so `jsonCanonical.ts` is not needed.

## T109 — restore on a synced device: implemented (owner decision 2026-10-05, option b)

The hub is unchanged. After a restore of a database that had synchronized, the device takes a **new sync identity**:

1. **Marker.** `restoreBackupV3` writes the state into the staging copy, so it lands with the same atomic swap as
   the data. It goes into `motard_sync_restore`, a SQLite-only table added by migration
   `0002_sync_restore_state`, with phase `register` and the previous sync identities.
2. **Register.** `reconcileRestoredSnapshot` (`application/use-cases/sync/syncRestoreUseCases.ts`, ports only)
   registers a new sync device id on the hub and in the local registry. The fingerprint is derived from the previous
   one (`<fp>#r<generation>-<id8>`), because the hub resolves an unknown id by fingerprint and would otherwise hand
   back the old identity. That costs one device seat, as accepted. The previous identities' restored number blocks
   are stale, so they are retired (`retireForDevice`), and fresh blocks are reserved for the new identity.
3. **Pull, with push paused.** The device pulls from its restored cursor until the hub has nothing newer. Under the
   new identity the hub returns everything, including this device's own work done after the backup. A pulled unit
   whose op-id is in this database's outbox is the device's own: it is not re-applied, and an unsettled outbox unit
   is acknowledged `synced`, so it is never pushed again (SY-7).
4. **Done.** Normal sync resumes under the new identity. Conflicts with newer hub data go through the existing
   review (keep-server / rebase / withdraw).

A client still asserting a previous identity is mapped to the new one (`infrastructure/sync/restoredIdentity.ts`
in the auth middleware and the invoice route). `/sync/run` and `/sync/status` return the `restore` state.
The UI adopts the new device id and shows "بيانات أحدث على المركز — جارٍ الجلب" in the header while sync is paused.
Unit test: `backend/tests/sync-restore-reconcile.test.ts`, 6/6 on both engines.

## T110 — **PASS** for the restore scenario; convergence shows only the pre-existing items

`node backend/scripts/verify-sync-multidevice.mjs --ac8 --device-engine sqlite --restore` adds the quickstart §6
scenario after AC-8:

1. B works offline, so 3 units are still pending.
2. B's file is backed up through the production v3 backup.
3. B keeps working: 5 invoices, synced.
4. A writes 2 newer invoices.
5. B is restored through the same `restoreBackupV3` call as the desktop's startup "restore" choice.
6. B syncs, then works on (1 invoice).

| Check | Result |
|---|---|
| first run after the restore reconciles before pushing anything | PASS |
| reconcile done under a NEW sync identity | PASS |
| the hub knows the new identity as its own device (own id and fingerprint) | PASS |
| units the hub already held were NOT pushed again (SY-7) | PASS (1 push after the restore: the new invoice) |
| pushes after the restore carry the new identity | PASS |
| restored pending units acknowledged `synced` locally | PASS (3/3) |
| B got its own post-backup work back from the hub | PASS (5/5) |
| B got the peer's newer data | PASS |
| A, B and hub hold the same 61 invoices, no duplicate number | PASS |
| A / B business state = hub | FAIL: **only** pre-existing items 1–3 below, same as without a restore |

Along the way, the restore exposed a stale-number-block collision ("رقم الفاتورة مكرر" on B's first post-restore
invoice). It is fixed by retiring the previous identities' blocks and mapping the old identity, as described above.

T102 and T103 were re-run after T109: T103 still shows an empty diff across 162 files; T102 is unchanged.

## T104 — long offline (1, 7, 30, 90 days): engines identical; one SY-2 conflict

`node scripts/parity/offline-duration.mjs` runs one PostgreSQL-desktop pass and one SQLite-desktop pass. In each,
the hub is unreachable (a proxy refuses connections), and the device and hub clocks move to +1, +7, +30 and +90 days
via a test-only preload (`lib/clockShift.mjs`). At each step the device creates an invoice, cancels the previous
one, records a receipt and a stock-in, and reads its statement, sync status and licence status. Then it reconnects.

| Check | PostgreSQL | SQLite |
|---|---|---|
| ERP work offline at +1, +7, +30 days | PASS | PASS |
| ERP work offline at **+90 days (2027-01-03)** | **refused**: invoice and receipt 422 «نفدت كتلة الترقيم … لا توجد كتلة للسنة الحالية» | **same** |
| licence status identical at every step (no offline expiry) | PASS (404, no licence row on the test tenant) | PASS |
| all offline work queued (17 units) and drained after reconnecting | PASS | PASS |
| device = hub after reconnecting (`cancelled_at` aside) | PASS | PASS |
| PostgreSQL vs SQLite canonical diff | **PASS: empty diff across 107 files** | |

**SY-2 conflict (owner decision needed; not changed, as T104 requires).** Document number blocks are reserved per
calendar year, and a device holds blocks only for the year in which it was last online. A device that stays offline
across 1 January can no longer create numbered documents (invoices, receipts, …) until it reconnects. The rule is
time-based, the same on both engines and already present in the PostgreSQL reference.

## Pre-existing shared-sync behaviors (engine-independent; owner items)

1. Roll-creation `initial` stock movements are not synced.
2. After `keep-server`, the losing device keeps its own edit.
3. `stock_movements.balance_after_kg` depends on the order each node applied movements.
4. **New from T104:** an offline cancellation's `cancelled_at` is the time each node APPLIED it. The hub stamps the
   reconnect time, not the time the user cancelled (0/3 kept).
