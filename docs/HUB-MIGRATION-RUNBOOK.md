# Hub migration runbook — move the sync hub to another server, or roll back

Background: `MIGRATION_READINESS_AUDIT.md` (MIG-01 … MIG-08). This runbook applies the
fixes that are now in the code. Read the **limits** at the end before planning a move.

## What protects the data (and what you must still do)

| Mechanism         | Where                                                                                              | What it does                                                                                                                                                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hub epoch**     | `application/use-cases/sync/hubIdentity.ts`; returned by `GET /api/sync/pull`                      | The identity of this hub _instance_, per company. It persists across restarts. A server restored from a portable backup gets a new one automatically (it lives in `secrets`, which backups do not carry). Every restore path also rotates it, and `POST /api/sync/hub/identity/rotate` rotates it on demand.            |
| **Device rebase** | `syncUseCases.ts` `decideHubRebase` / `runLocalSyncPull`                                           | When the epoch changes, or the hub's stream head (`headSeq`) is **below** the device's cursor, the device resets its pull cursor, re-queues everything it already delivered, re-reports its number tips, then pulls from the start. All of it is idempotent: hub inbox `op_id` is unique, and replay is by document id. |
| **Write freeze**  | `HUB_WRITE_FREEZE=1` (`hubWriteFreeze.middleware.ts`)                                              | Every mutation answers 503. Devices keep their changes pending and retry. Reads, sign-in, `/api/integrity/*` and `/api/sync/hub/identity*` stay available.                                                                                                                                                              |
| **Fingerprint**   | `GET /api/integrity/fingerprint`; `npx tsx scripts/compare-hub-fingerprints.mts old.json new.json` | Per company: row count + sha256 per table, balances per party and currency, roll stock, sync stream head. The comparison exits 0 only if everything matches.                                                                                                                                                            |
| **Preflight**     | `GET /api/integrity/cutover-preflight`                                                             | Checks the new host: `JWT_SECRET`, that `APP_MASTER_KEY` can decrypt the stored secrets, licence, CORS, and devices without a hub credential.                                                                                                                                                                           |
| **Hub backups**   | `HUB_BACKUP_DIR`, `HUB_BACKUP_INTERVAL_HOURS` (`hubBackupScheduler.ts`)                            | One portable v2 archive per company, verified before it is kept. **Nothing is ever deleted**: copying off-site and retention are your job.                                                                                                                                                                              |
| **Restore paths** | `portableBackup.ts` restore, `scripts/restore-from-backup.mjs`                                     | Keep `applied_seq` (trigger disabled during the load, standalone sequence advanced), drop the hub epoch, and end every pre-restore session.                                                                                                                                                                             |

**Prerequisite:** the hub **and every desktop** run this version. An older device ignores the epoch,
so it gets no protection.

## Cutover (old server → new server)

1. **Freeze the old server.** Set `HUB_WRITE_FREEZE=1` and restart. Shops keep working offline;
   their pushes wait.
2. **Fingerprint the old server**, one file per company: `GET /api/integrity/fingerprint` → `old-<company>.json`.
3. **Take the final backup** of each company: `POST /api/backup/full` (portable v2). For a
   whole-database move, use a dump of the entire database instead.
4. **Prepare the new host** with the **same** `JWT_SECRET` and `APP_MASTER_KEY`, plus `CORS_ORIGIN`
   (including the web origin), its own `DATABASE_URL`, and `HUB_WRITE_FREEZE=1`. Apply the schema
   migrations, then restore:
   - portable backup: `POST /api/backup/restore` — the epoch rotates by itself;
   - whole-database dump: restore it, then **step 6 is mandatory**.
5. **Verify before any device can reach it:**
   - `GET /api/integrity/fingerprint` on the new server → `new-<company>.json`, then
     `npx tsx scripts/compare-hub-fingerprints.mts old-<company>.json new-<company>.json` must exit 0.
     `audit_logs` differences are warnings only.
   - `GET /api/integrity/cutover-preflight` must show no `failed` check. Fix warnings, or accept them
     knowingly.
6. **Rotate the epoch on the new server:** `POST /api/sync/hub/identity/rotate {"reason":"cutover <date>"}`.
7. **Switch DNS** to the new server. Remove `HUB_WRITE_FREEZE` there and restart.
8. **Watch:**
   - each device logs "hub instance changed — pull cursor reset, delivered history re-queued";
   - each device's outstanding outbox returns to 0;
   - `GET /api/sync/hub/identity` shows `headSeq` growing.
9. **Keep the old server frozen. Do not delete it** until the rollback window is over.

## Rollback (new server → old server)

1. Freeze the **new** server (`HUB_WRITE_FREEZE=1`).
2. Switch DNS back to the **old** server.
3. On the old server: `POST /api/sync/hub/identity/rotate {"reason":"rollback <date>"}`, then remove
   `HUB_WRITE_FREEZE`.
4. Every device rebases and re-delivers its whole history, **including what it made while it was on
   the new server**. Duplicates are refused by op id.
5. Compare fingerprints of the new (frozen) and old servers. Anything left that the old server lacks
   was written **directly on the new hub**, e.g. through the web UI. See the limits.

## Limits — not solved by code (decide before a move)

- **Writes made directly on the hub** (hub web UI, not a desktop) are in no device outbox. Hub-origin
  writes are also not in the pull stream at all: devices never receive them, a gap that predates this
  work. A rollback cannot bring them back automatically. Avoid web-UI writes during the rollback
  window, or re-enter them after comparing fingerprints.
- **Device credentials:**
  - Devices enrolled with an enrollment code keep their hub credential in `secrets`. A portable
    backup does not carry it, so after a portable restore those devices must sign in with an account
    or re-enroll. The preflight lists how many are affected.
  - A whole-database move keeps the credentials, provided `APP_MASTER_KEY` is the same.
- **Number counter (MIG-06):** the tip re-report advances the hub counter by at most 2000 per entity
  type per report. That is the same safety cap as the existing tip reconciliation, and it was not
  changed. If more numbers than that were issued after the backup, or another device claims a new
  block before the holder reports, an overlap is still possible. The sync collision rule keeps every
  document, but a duplicated number gets a suffix.
- **Every session ends after a restore (MIG-07):** revocations made after the backup cannot be known.
  Users sign in again, and devices re-authenticate with their stored credentials.
- **Not executed in this environment:** the PostgreSQL restore paths, the hub backup export, and a
  real DNS move. Run `scripts/restore-drill.mjs` and one cutover rehearsal on a disposable hub
  before a production move.
