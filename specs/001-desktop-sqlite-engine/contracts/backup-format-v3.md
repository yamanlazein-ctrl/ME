# Contract: Desktop Backup Archive, Format v3

**Producer**: desktop backend (`createAndVerifyBackup`). **Consumers**: desktop restore and the restore-test.
The cloud keeps format v2 unchanged.

## Archive layout (`.zip`)

```text
manifest.json        format, version, identity, per-table counts + hashes, file list
manifest.sha256      hex sha256 of manifest.json bytes
database.sqlite      online-backup copy, device-bound tables removed, device-bound columns nulled, VACUUMed
files/logos/…        company logo files
files/attachments/…  attachment files referenced by `attachments` rows
```

## `manifest.json`

| Field | Type | Rule |
|---|---|---|
| `format` | `"motard-erp-backup"` | must match |
| `formatVersion` | `3` | `> 3` → reject "newer than app". `2` (PostgreSQL era) → reject (OQ-3, DB-8). |
| `createdAt` | ISO UTC | — |
| `app.version` | string | — |
| `schema.journalIdx`, `schema.fingerprintSha256` | int, hex | `journalIdx` newer than the app → reject. Older → migrate a staging copy. |
| `data.dataId` | UUID | equals the source `motard_meta.data_id` |
| `tenant.id`, `tenant.name` | UUID, string | — |
| `tables[]` | `{name, rows, sha256}` | `sha256` over the canonical row dump (sorted by PK, canonical JSON per row) |
| `files[]` | `{path, bytes, sha256}` | every file under `files/` |
| `excludedTables` | string[] | device-bound tables (BK-2, FR-042), **not** v2's `DEVICE_BOUND_TABLES`, which also excludes `licenses`: `license_activations`, `device_registrations`, `secrets`, `server_installations`, `revoked_tokens`, `idempotency_keys`, `invitation_codes`, `license_audit_events` |
| `nulledColumns` | `{table: string[]}` | `{"licenses": ["binding_type","binding_value","offline_token","offline_token_jti"], "tenants": ["activation_id"], "sync_devices": ["device_registration_id"]}` (the last one added by research I-18, 2026-10-03; both FK columns are nullable) |
| `licence` | `{licenseId, key, type, edition, plan, status}` | copy identification (BK-2). Read from the kept `licenses` row. |
| `sync` | `{deviceId, lastPushedSeq, lastPulledCursor}` or null | used by SY-6 reconciliation |

## Licence and device-bound state (BK-2, FR-042; decided from code evidence 2026-10-03)

- **Kept (company licence identity)**: the `licenses` row, every column except the four in `nulledColumns.licenses`.
- **Excluded (device-bound)**: the `excludedTables`. `license_audit_events` is excluded because every current writer
  records a device or activation event (`activationId`, `serverFingerprint`, `deviceId` in the payload). It is the device's
  append-only activation log, not company data (research R10).
- **Nulled**: `nulledColumns`, which follow each column's live FK action (`tenants.activation_id` is ON DELETE SET NULL).

## Creation (all paths: manual, automatic, pre-operation, pre-migration, pre-update, pre-restore)

1. `db.backup(tmp)`
2. `integrity_check` = `ok` and `foreign_key_check` empty on `tmp`
3. delete `excludedTables` rows, set `nulledColumns` to NULL, confirm `foreign_key_check` is still empty, then `VACUUM`
4. build the zip to `<final>.partial`
5. `fsync(file)`
6. rename to `<final>`
7. `fsync(dir)`
8. **verify** (below)
9. registry status = `VERIFIED`

Any failure means status `FAILED`, the `.partial` file is removed and the user sees an explicit failure. The file is never listed as a backup.

## Verification (also used before every restore and by the weekly restore-test)

- **Archive**: zip CRC passes, `manifest.sha256` matches, every `files[]` hash matches.
- **Database**: extract `database.sqlite` to temp, then `PRAGMA integrity_check` = `ok` and `foreign_key_check` is empty.
- **Content**: per-table `rows` and `sha256` recomputed from the extracted database match the manifest.
- **Manual download (desktop)**: the saved file's size and sha256 equal the verified file's. The web/cloud app keeps
  its existing browser download unchanged.

## Restore guarantees

- The source archive is opened read-only and never modified (RS-3).
- A VERIFIED safety backup of the current state is taken first (RS-6).
- Migration runs only on the staging copy. The live file is swapped only after the RS-5 comparison passes.
- **Device-bound carry-over**: before the swap, the live database's `excludedTables` rows, its `nulledColumns.licenses`
  values (when the licence id matches) and `tenants.activation_id` are copied into the staging copy. A same-device
  restore keeps its activation, binding, secrets and activation log. A new-device restore has none, so the licence must be
  verified on that device.
- The previous live file is kept in `set-aside\`.
