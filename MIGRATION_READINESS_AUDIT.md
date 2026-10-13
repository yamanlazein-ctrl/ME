# Hub migration readiness audit — Motard ERP (2026-10-12)

**Question.** Can the sync hub move to another hosting provider or a new VPS at any time with no
data loss, no duplicate invoices, no balance or stock drift, no loss of unsynchronized changes and no
client failures?

**Answer: not safely today.** Two critical defects lose data silently in the most likely migration:
the same domain pointed at a new server restored from a backup. Duplicate invoices are prevented, and
offline changes that were never delivered are kept. But changes already delivered to the old server,
and changes made on the new one, can be skipped without any error.

**Method.**

- Everything below was read from the current code (HEAD `a3882558` plus the working tree).
- SQLite only. PostgreSQL was not started, nothing was built or deployed, and no data was deleted.
- The only code added is one test file: `backend/tests/sqlite/hub-migration-readiness.test.ts`.
- The production hub runs on PostgreSQL. Its SQLite twin has the same `applied_seq` trigger and the
  same pull filter, so the hub cases are reproduced on that twin. Section 4 says what still needs
  PostgreSQL.

---

## 1. How the system binds to the server (item 1)

| Fact                                                                                                                                                         | Evidence                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| The desktop UI never talks to the hub. It reaches the local sidecar over a named pipe / IPC; the sidecar alone calls the hub.                                | CLAUDE.md layout; `src/lib/api-base-url.ts:28-45` (desktop uses same-origin `/api`)                          |
| The hub address is not hard-coded anywhere. Resolution order: runtime value, then env `CENTRAL_SYNC_URL`, then `hub.json`, then the stored credentials' URL. | `backend/src/application/use-cases/sync/hubConfig.ts:89-95`, `:98-117`; `env.ts:127`                         |
| The web client (hub-served UI) uses the same origin, or a `localStorage` override.                                                                           | `src/lib/api-base-url.ts:1,16-27`                                                                            |
| No certificate or host pinning: plain `fetch` with normal CA verification. A new host with a valid certificate is accepted.                                  | no `rejectUnauthorized` / pinning anywhere in `backend/src`, `src`, `desktop/src-tauri/src`                  |
| Hard-coded domain: the desktop updater feed only.                                                                                                            | `desktop/src-tauri/tauri.conf.json:62` (`updates.motardfabrics.com`)                                         |
| Hub tokens are signed with `JWT_SECRET`. Device credentials for the hub are encrypted with this install's `APP_MASTER_KEY`.                                  | `env.ts:110`; `hubConfig.ts:165-186`; `refreshHubSession` → stored-credential relogin `hubConfig.ts:308-311` |
| **Hub identity, as the device sees it, is just `(URL, hub tenant id)`.**                                                                                     | `hubConfig.ts:736-739` and `:875-878` (`hubChanged`)                                                         |

**On the client when the backend changes:**

- A DNS change is transparent.
- A new `JWT_SECRET` causes a 401, after which the device logs in again with its stored credentials.
- A new URL plus a manual reconnect sets `hubChanged = true`. This resets the pull cursor and
  re-delivers everything (`sync.route.ts:422-433`, `:1595-1599`), which is the safe path.
- **Same URL (or same tenant id):** nothing resets. That is MIG-01.

---

## 2. Confirmed issues (ordered by severity)

### MIG-01 — CRITICAL — A move behind the same address is invisible to devices; their delivered and pulled history is never reconciled

- **Evidence:**
  - `hubChanged` compares only URL and hub tenant id (`hubConfig.ts:736-739`).
  - Re-delivery (`requeueSyncedForNewHub`, `sqlite/SqliteSyncOutboxRepository.ts:308-337`) and the
    cursor reset run **only** when `hubChanged` is true (`sync.route.ts:430-433`, `:1597-1599`).
  - A restored hub keeps its tenant id, and the domain stays the same, so neither runs.
  - The pull cursor is stored per tenant with no hub identity (`orm/sqlite/migrations/0000_baseline.sql:1288-1296`).
  - The cursor can only move forward (`sqlite/SqliteSyncStateStore.ts:54-63`, `setWhere last_pull_seq <= seq`).
- **Effects:**
  1. A unit the **old** server acknowledged after the backup was taken is marked `synced` on the
     device. It is never sent to the new server, so the hub and every other PC lose it.
  2. Units the new server numbers at or below a device's old cursor are never pulled by that device.
- **Proof (executed, SQLite):**
  - test _"MIG-01: after a move behind the SAME address …"_: the device asks `afterSeq=100`, the peer
    invoice is not applied; after a reset it is.
  - test _"offline changes across a switch …"_: the delivered unit is not re-sent until
    `requeueSyncedForNewHub` runs.

### MIG-02 — CRITICAL — Neither restore path restores the pull-stream sequence (`applied_seq`)

- **Evidence:**
  - The pull reads `applied_seq > afterSeq` (`PostgresSyncInboxRepository.ts:136-160`; twin
    `SqliteSyncInboxRepository.ts:129-170`).
  - `applied_seq` comes from the standalone sequence `sync_inbox_applied_seq`, which a trigger assigns
    on every insert or update to `applied` (`orm/migrations/20261016_sync_inbox_applied_seq.sql:16,26,29-41`).
    A fresh database starts it at 1 (line 26).
  - **Portable backup v2** (`backup/portableBackup.ts`): the restore runs with triggers disabled
    (`:584`), so the restored rows keep their numbers. But only sequences **owned by a column** are
    advanced (`:640-655`, `pg_depend deptype a/i`). `sync_inbox_applied_seq` is not owned, so it stays
    at 1, and new units get numbers **below** the restored maximum.
  - **`scripts/restore-from-backup.mjs`:** advances `received_seq` only (`:319-324`, `:396-414`).
    It disables only the ledger trigger (`:328`), so the applied-seq trigger **renumbers** every
    restored applied row. Its cursor rule still reasons about `received_seq` (`:416-460`), as does
    `docs/SYNC-OPERATIONS.md:110`.
- **Effect:** on the migrated hub, every new unit is invisible to every device whose cursor is above
  the new numbers. No error, no conflict, and the device reports "synced".
- **Proof (executed on the SQLite twin):**
  - _"a hub restored by re-inserting its inbox renumbers applied_seq"_: an explicit 900 is overwritten.
  - _"new units are never returned to a device whose cursor is ahead"_: `listAppliedSince(cursor)` returns `[]`.
  - _"the device pull cursor only moves forward"_: cannot recover without an explicit reset.
- **Not executed:** the PostgreSQL restore itself (forbidden here). See §4.

### MIG-03 — HIGH — The hub has no automatic backup

- **Evidence:** both backup schedulers start only when `DESKTOP_DEPLOY` is on (`presentation/server.ts:771-785`;
  `backup/backupScheduler.ts:149`). The hub's only backup is the manual `POST /api/backup/full`
  (portable v2, which is itself sound: repeatable-read snapshot `portableBackup.ts:236`, sha256-verified
  staged restore `:1-37`).
- **Effect:** a provider failure, or a mistake during a move, loses everything since the last manual
  export. The provider's own snapshots (Render) are outside the code and unverified.

### MIG-04 — HIGH — No way to prove before cutover that the new server holds the same data as the old one, and no write freeze

- **Evidence:**
  - `scripts/reconcile-integrity*.mjs` check invariants **inside one** database only (header of
    `reconcile-integrity-sqlite.mjs:1-17`).
  - The portable restore proves "copy = archive", not "archive = live server at the cutover moment".
  - Writes keep landing on the old server after the export. Data-safe mode (read-only 503) is entered
    automatically only (`integrity/dataIntegrityManifest.ts:174`, `server.ts:688-699`); there is no
    operator switch.
- **Building block that already exists:** a 503 on push is retried and the unit stays pending
  (`syncUseCases.ts:689-698`).
- **Proof (executed):** the PoC fingerprint in the test (per-tenant row counts + sha256 per table,
  party balances, roll stock) matches a consistent copy exactly. It also catches one write made after
  the snapshot, naming invoices, ledger, balances and stock.

### MIG-05 — HIGH — No rollback procedure; writes made on the new server would be lost on rollback

- **Evidence:** no cutover or rollback script or runbook section exists (`docs/SYNC-OPERATIONS.md`
  headings; the `backend/scripts` "rollback" matches are database-transaction rollbacks). Moving DNS
  back is again a same-address move, so MIG-01 applies.
- **Proof (executed):** test _"rollback …"_. The old server lacks the post-cutover invoice. The new
  server's inbox names the missing units by `op_id`, and replaying them into the old server is complete
  and idempotent (the second replay gives `created:false` / `exists`).

### MIG-06 — MEDIUM — Restoring from an older point rewinds number ranges; issued numbers can collide and get renamed

- **Evidence:**
  - The hub carves new ranges from `document_sequences.last_number`, raised only by the **requesting**
    device's own local tip (`PostgresNumberBlockStore.ts:24-52`).
  - A rewound counter can hand out a range another device already holds.
  - On sync the collision converges, and no record is lost: the smaller id keeps the number, the other
    gets a suffix (`syncNumberCollision.ts:9-25,63-80`). But a number that was already printed then
    changes, which contradicts "numbers are final at issue time" (`document-number-block.table.ts:14-17`).
- **Status:** confirmed by code reading; not reproduced (it needs the PostgreSQL hub).

### MIG-07 — MEDIUM — Backups drop `revoked_tokens` and `idempotency_keys`

- **Evidence:** `portableBackup.ts:66-76` (`DEVICE_BOUND_TABLES`).
- **Effects:**
  - **Confirmed:** revoked sessions become valid again on the new hub until they expire, if
    `JWT_SECRET` is reused.
  - **Suspected:** a web client (hub-direct) that retries a POST across the cutover with the same
    `Idempotency-Key` is not de-duplicated, so a duplicate document is possible. Desktop clients are
    **not** affected: they de-duplicate by `op_id` and document id (see §3).

### MIG-08 — MEDIUM — The new host must receive the same secrets and licence, or clients stop working

- **Evidence:**
  - `APP_MASTER_KEY` and `JWT_SECRET` are mandatory (`env.ts:110`). The backup omits `secrets`,
    `licenses`, `license_activations` and `device_registrations` (`portableBackup.ts:66-76`).
  - With a different `JWT_SECRET`, every token is invalid. Devices log in again with stored
    credentials (`hubConfig.ts:308-311`).
  - **Suspected:** without a licence, the licence guard on the API blocks clients (an outage, not data loss).
  - `CORS_ORIGIN` must list the web origin (`env.ts:95`).

### MIG-09 — LOW

- A desktop-updater domain change needs a new build (`tauri.conf.json:62`).
- The documentation still names `received_seq` as the pull cursor (`docs/SYNC-OPERATIONS.md:110`,
  `restore-from-backup.mjs:310-324`).

---

## 3. Verified safe (with evidence)

| Property                                                                              | Evidence                                                                                                                                                                                                                                              | Proof                                                                                                                             |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **No duplicate invoices or documents on re-delivery** (requeue, replay, restored hub) | hub inbox unique on `(tenant_id, op_id)` (`orm/migrations/0048_sync_outbox_inbox.sql:48`); invoice replay de-duplicates by id (`syncMaterialize.ts:449-465`) and keeps the device's id and number (`preAllocatedId`/`preAllocatedNumber`, `:489-498`) | test _"duplicate-invoice prevention"_: same unit twice → one invoice, ledger and stock moved once; same `op_id` → `created:false` |
| **Offline changes are persisted and survive a server switch**                         | outbox in local SQLite (`0000_baseline.sql:1235-1266`); 5xx / 401 / 403 / 408 / 425 retried, unit stays pending (`syncUseCases.ts:476-480,689-698`)                                                                                                   | test _"offline changes across a switch"_: the pending unit reached the new server                                                 |
| **Desktop backups are complete and verified**                                         | `VACUUM INTO` → `integrity_check` + FK check → `.partial` → rename → full verification → registry VERIFIED (`backup/sqliteBackup.ts:6-8,181-184,348`)                                                                                                 | earlier rounds' suites (`backup-v3`, `restore-path`, `restore-rs5`)                                                               |
| **The hub's portable backup is internally consistent and verified on restore**        | repeatable-read snapshot (`portableBackup.ts:236`); staged restore, sha256 re-check, FK check, one transaction (`:23-37,584-660`)                                                                                                                     | PostgreSQL only — not run here                                                                                                    |

---

## 4. Remediation plan (root causes first)

1. **Hub epoch: fixes MIG-01, MIG-02 and MIG-05 at the root.**
   - The hub stores a random `hub_epoch` (UUID) that every install, restore or "migration complete"
     step regenerates. It returns the epoch on every pull, push and status response.
   - The device stores its cursor keyed by `(hub URL, hub epoch)` in a new `sync_state` column
     (migrations for both engines).
   - On a mismatch, the device automatically calls the existing `resetPullCursor` and
     `requeueSyncedForNewHub`.
   - Both are idempotent: inbox `op_id` uniqueness plus id-based replay, which the test proves.
   - This turns every move into the already-safe `hubChanged` path, without trusting the domain name.
   - Acceptance: the four CONFIRMED-DEFECT tests must flip, i.e. be rewritten to expect recovery.
2. **Restore the pull-stream sequence in both restore paths (MIG-02).**
   - After loading, `setval('sync_inbox_applied_seq', max(applied_seq))`, and in general every
     standalone sequence (not only owned ones).
   - In `restore-from-backup.mjs`, run the load with triggers disabled (`session_replication_role = replica`)
     so `applied_seq` is not renumbered, or retire the script in favour of portable v2.
   - Update `docs/SYNC-OPERATIONS.md:110`.
3. **Scheduled, off-site, verified hub backups (MIG-03).** Run the portable v2 export on a timer on
   the hub, keep a retention set, copy it to a second provider, and run a monthly restore drill
   (`scripts/restore-drill.mjs`) with the fingerprint check.
4. **Cutover tooling (MIG-04).**
   1. An operator-controlled **freeze**: data-safe mode switchable by an admin. It returns 503 on
      mutations, which devices already retry and keep pending.
   2. Final portable backup.
   3. Restore on the new host.
   4. **Fingerprint comparison of the old and new server** (the PoC in the test, turned into a script:
      per-table counts and sha256, party balances per currency, roll stock, outstanding inbox).
   5. Bump the epoch.
   6. Switch DNS.
   7. Unfreeze.
5. **Rollback (MIG-05).**
   - Keep the old server frozen, not deleted.
   - Rollback means: DNS back, plus an epoch bump on the old server. Devices re-deliver everything,
     idempotently, so post-cutover writes come back.
   - Plus a delta tool: units in the new inbox whose `op_id` is missing from the old inbox are replayed
     into the old server (proven feasible by the test).
6. **Number ranges after a restore or epoch change (MIG-06).** On the new epoch, raise
   `document_sequences.last_number` above the highest number present in restored documents and blocks.
   Devices report their local tips again when re-pairing.
7. **Backup contents (MIG-07).** Include `revoked_tokens`, or rotate a token generation on the new
   hub. For hub-direct web creates, send a client-generated document id, so retries de-duplicate by id
   and not only by idempotency key.
8. **Host carry-over checklist (MIG-08).** `JWT_SECRET`, `APP_MASTER_KEY`, `CORS_ORIGIN`, licence
   activation, `CENTRAL_SYNC_URL` of devices (unchanged), health check on the new host before DNS.

---

## 5. Tests

**Executed:** `backend/tests/sqlite/hub-migration-readiness.test.ts`, run with
`cd backend && DB_ENGINE=sqlite npx vitest run tests/sqlite/hub-migration-readiness.test.ts`.
Result: **8/8 passed**. The full SQLite suite then gave **181 passed, 10 skipped files; 979 passed,
43 skipped tests, 0 failed**. The test uses a temporary database and a fake hub on localhost. It
never touches `%LOCALAPPDATA%\motard-erp`.

| #   | Test                                          | Shows                                                                                                               |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | duplicate-invoice prevention                  | a re-delivered invoice unit is applied once; ledger and stock move once; same `op_id` is refused                    |
| 2   | pre-cutover verification (PoC fingerprint)    | identical copy → no differences; a post-snapshot write is detected (invoices, ledger, balances, stock)              |
| 3   | MIG-02 renumbering _(CONFIRMED-DEFECT)_       | restored `applied_seq` values are overwritten by the trigger                                                        |
| 4   | MIG-02 skip _(CONFIRMED-DEFECT)_              | units on a hub behind the device cursor are never returned                                                          |
| 5   | MIG-02 monotonic cursor _(CONFIRMED-DEFECT)_  | the device cannot adopt the new hub's lower numbering without an explicit reset                                     |
| 6   | MIG-01 same-address move _(CONFIRMED-DEFECT)_ | the device pulls with its old cursor and misses a peer invoice; a reset recovers it                                 |
| 7   | offline changes across a switch               | pending work survives; already-delivered work reaches a restored server only after requeue; re-delivery is harmless |
| 8   | rollback                                      | the post-cutover delta is identified by `op_id` and replayed into the old server completely and idempotently        |

The CONFIRMED-DEFECT tests assert today's unsafe behaviour on purpose. They are the acceptance
criteria for remediation items 1 and 2: once those are fixed, the tests must be rewritten to expect
recovery.

**Not runnable here (and what they would verify):**

- **PostgreSQL restore drill** (portable v2 and `restore-from-backup.mjs`) onto a fresh database,
  followed by a new pushed unit: would confirm `nextval('sync_inbox_applied_seq')` lands below the
  restored maximum (MIG-02) and that the item 2 fix closes it.
- **Two real desktops plus two real hubs across a DNS switch**: would show end-to-end convergence of
  documents, balances and stock, and the epoch-driven automatic recovery (item 1).
- **Number-range rewind on a hub restored from an older backup**: would show the overlapping range
  and the suffix rename of an issued number (MIG-06), and that item 6 prevents it.
- **Web-client retry across cutover with the same `Idempotency-Key`**: would confirm or clear the
  suspected duplicate in MIG-07.
- **Licence guard on a fresh host without activation**: would confirm the suspected outage in MIG-08.

---

## 6. Remediation status (2026-10-12, second pass): code fixed, SQLite only

No schema change was made: a new table would need the PostgreSQL schema fingerprint regenerated from
a live database, and PostgreSQL may not be run here. The hub epoch therefore lives in the existing,
encrypted per-company `secrets` store. The runbook is `docs/HUB-MIGRATION-RUNBOOK.md`.

| Item       | Root cause                                                                                                                         | Fix (files : lines)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Verification                                                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MIG-01** | Hub identity was only the URL plus the hub tenant id, so a same-address move was invisible.                                        | **Hub epoch:** `application/use-cases/sync/hubIdentity.ts` (new). Returned on every pull: `sync.route.ts:1301`. Admin `GET/POST /sync/hub/identity[/rotate]`: `sync.route.ts:1309,1329`. **Device:** `decideHubRebase` + rebase in `runLocalSyncPull` (`syncUseCases.ts:52`, `823`, `929`): cursor reset → re-queue → number tips → epoch remembered last (crash-safe), then a re-pull from the start. The route passes the actions (`sync.route.ts:832`). **Epoch kept on re-pair / re-login to the same hub:** `hubConfig.ts:381,441,735,887`. | Acceptance tests executed (SQLite): _epoch changed_ · _without actions nothing applied_ · _cutover_ · _rollback_. RED: with detection disabled, 7 tests fail.                                                    |
| **MIG-02** | `sync_inbox_applied_seq` is owned by no column, so restore never advanced it; the legacy script's insert re-stamped `applied_seq`. | Pull returns `headSeq` (`maxAppliedSeq` in both repos and the port, over every row that drew a number). The device rebases when `headSeq` < its cursor. `portableBackup.ts:68,655-672`: advance the standalone sequence, drop the epoch. `restore-from-backup.mjs:354,413,451,457`: trigger disabled during the load, backfill, `setval`, drop the epoch. Docs: `SYNC-OPERATIONS.md` table row.                                                                                                                                                  | Acceptance test _stream rewound_ executed. **The PostgreSQL restore paths were not executed** — source-contract test only.                                                                                       |
| **MIG-03** | No backup at all on the hub.                                                                                                       | `infrastructure/backup/hubBackupScheduler.ts` (new; `.partial` → verify → keep, never deletes, `.failed` on error); wired for the hub only, opt-in via `HUB_BACKUP_DIR` (`server.ts:205,829`).                                                                                                                                                                                                                                                                                                                                                   | Orchestration test executed with fakes. **The PostgreSQL export was not executed.**                                                                                                                              |
| **MIG-04** | No way to freeze writes and no comparison of old and new server.                                                                   | `HUB_WRITE_FREEZE` guard (`hubWriteFreeze.middleware.ts`, mounted `server.ts:248`). Fingerprint (`integrity/hubFingerprint.ts` + `hubFingerprintCompare.ts`, endpoint `GET /api/integrity/fingerprint`, CLI `scripts/compare-hub-fingerprints.mts`).                                                                                                                                                                                                                                                                                             | Freeze, fingerprint and compare tests executed (SQLite).                                                                                                                                                         |
| **MIG-05** | Rollback was again a same-address move, with no procedure.                                                                         | Epoch rotation on the old server + device re-delivery (MIG-01 mechanism). Runbook rollback section.                                                                                                                                                                                                                                                                                                                                                                                                                                              | _Rollback_ acceptance test (device re-delivers its post-cutover changes, each op once) and _hub-side delta replay by op id_ executed.                                                                            |
| **MIG-06** | A restored hub's counter can be below the ranges devices received after the backup.                                                | `raiseTip` (both stores and the port), `raiseNumberTip` / `reassertNumberTipsOnHub` (`numberBlockUseCases.ts:257,277`), `POST /sync/number-blocks/tip` (`sync.route.ts:1383`). Called on every rebase.                                                                                                                                                                                                                                                                                                                                           | Tip re-report (device → hub), never lowers, bounded, no block carved, refuses foreign device: executed. **Residual:** the existing +2000 cap and the window before the holder reports (documented; not changed). |
| **MIG-07** | `revoked_tokens` / `idempotency_keys` were excluded from backups; revocations after the backup are unknowable.                     | Both now included (`backup/deviceBoundTables.ts`, re-exported by `portableBackup.ts`). Both restore paths end every pre-restore session (`tokens_revoked_before = now()`).                                                                                                                                                                                                                                                                                                                                                                       | Exclusion list test executed. **The restore SQL was not executed** (PostgreSQL).                                                                                                                                 |
| **MIG-08** | A new host can hold the data yet fail every client.                                                                                | `integrity/cutoverPreflight.ts` + `GET /api/integrity/cutover-preflight`: JWT secret, `APP_MASTER_KEY` decryptability, CORS, licence, devices without credentials, epoch, freeze.                                                                                                                                                                                                                                                                                                                                                                | Preflight test executed (SQLite).                                                                                                                                                                                |

**A defect found while fixing:** the first version of the fingerprint imported `portableBackup.ts`, which
loads the PostgreSQL layer. On the desktop that endpoint would have hit the
`PG_LAYER_LOADED_UNDER_SQLITE` guard. The table list moved to the dependency-free
`backup/deviceBoundTables.ts`.

**Results (executed, SQLite only):**

- `tests/sqlite/hub-migration-readiness.test.ts` **22/22**.
- Backend SQLite suite **181 passed, 10 skipped files; 993 passed, 43 skipped tests, 0 failed**.
- Frontend **99/99 files, 425/425**.
- Desktop script tests **31/31**.
- `tsc` root and backend: 0 errors. `typecheck:sqlite` passes.
- Lint root and backend: 0 errors, 0 warnings. `prettier --check .`: clean.

**Not verified here:** both PostgreSQL restore paths, the hub's PostgreSQL backup export, a real DNS
cutover with two devices, and a hub running PostgreSQL end to end.

**Server-move readiness is therefore not declared.** It requires, on a disposable PostgreSQL hub:
`scripts/restore-drill.mjs`, plus one rehearsal of the runbook (cutover and rollback) with two devices.
