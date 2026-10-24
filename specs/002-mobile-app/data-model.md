# Data Model: Motard ERP Mobile (Android v1)

The phone uses the existing SQLite schema unchanged: the same Drizzle schema files in
`backend/src/infrastructure/orm/sqlite/schemas/`, the same 10 migrations in
`backend/src/infrastructure/orm/sqlite/migrations/`, and the same schema fingerprint
(`backend/src/infrastructure/orm/sqlite/schemaFingerprint.ts`). v1 adds no business table and no
column. Any schema change follows constitution V: a migration for each engine, journals in sync,
and `npm run typecheck:sqlite` passing.

## Business entities (existing; meaning as in spec "Key Entities")

- **parties**: customers and suppliers. `UNIQUE(tenant_id, name)`. Opening balances are journaled
  in the ledger (decisions D-003, D-004).
- **fabrics**: name, category, `minStockKg`, unit, notes, imageUrl. **colors**: belong to a fabric;
  code and hex. **rolls**: `color_id` NOT NULL, `remaining_kg` ≥ 0 (check
  `ck_remaining_kg_nonnegative`), `price_per_kg` NOT NULL, `supplier_id` nullable, `entry_source`
  one of purchase, press or stock_in.
- **stock_movements**: every kilogram change of a roll (initial, sale, return, adjustment, count).
- **inventory counts**: count sheets posted as adjustment movements.
- **invoices** and **invoice_lines**: `invoice_lines.roll_id` NOT NULL; `cost_per_kg` is the
  snapshot taken at sale (used for COGS). Header `exchange_rate` is frozen. `status` is active or
  cancelled.
- **returns** and **return_lines**: reference a source invoice.
- **vouchers** (receipts and payments): amount moved, write-off `discount`, settlements.
- **expenses**, **orders** and **order_items**.
- **ledger_entries**: append-only by trigger; about 20 entry types (`LEDGER_ENTRY_TYPES`).
  **ledger_entry_archive** is read for history.
- **cashbox** daily balance series: maintained by triggers on ledger entries and manual movements.
  A back-dated insert updates later days.
- **financial_years**: closed years refuse writes.
- **settings**, **company_profile**, **notifications**, **audit_log**.

Money columns: SQLite stores scaled integers, read exactly (`exactIntegers.ts`: `bigint` beyond
±2^53). PostgreSQL stores `numeric(14,2)`.

## Sync entities (existing)

- **sync_outbox** (on the device): one row per unit, with a durable `op_id` unique per tenant,
  entity type, entity id, operation, payload, lane and status.
- Status transitions:
  - `pending` → `delivered`, after the hub accepts it
  - `pending` → `rejected`, when the hub answers `accepted: false`; the claim loser's document is
    cancelled locally
  - `pending` → `dead`, after 5 failed materializations on the hub; a human decides, and there is
    no requeue
  - `delivered` → `pending`, only through a hub-epoch rebase (requeue of delivered history)
- **sync_inbox** (on the hub, and locally for applied pulls): deduped on `(tenant_id, op_id)`;
  `applied_seq` is the pull cursor order.
- **sync_resource_claims**: first-write-wins reservations, for example a roll's stock.
- **document_number_blocks**: ranges per device and entity type. Phone sizes: invoice 100, every
  other type 50 (BC-1). **document_sequences**: fallback and floor tracking, with `knownUsed`
  reported on each claim.
- **sync_devices** and **sync_device_authorized_users**: device identity, credential, `revokedAt`
  and `revokeReason`.

The entity types that sync, from `syncEnqueue.ts`: cashbox, color, company, expense, fabric,
invoice, ledger, order, party, print, return, roll, settings, settlement, user, voucher.

## SQLite-only runtime tables (existing; used as on the desktop)

- **motard_meta**: one row (`id = 1`). It holds the identity of the database file: `data_id`,
  `tenant_id` (the single company), `schema_journal_idx` and the installation fields. On the phone,
  `created_by_installation_id` holds the phone's installation id, which is created at enrollment
  and stored in secure storage. It is NOT a key-value store. The PRD §12 wording "key-value" is
  corrected here.
- **motard_sequences**, **motard_tx_state** (transaction clock and session flags).
- **motard_drive_*** tables: created by the migrations, never written on the phone.

## Phone-only state (outside the database)

Kept in Android Keystore-backed secure storage (`expo-secure-store`):

- the SQLCipher database key
- the device credential from `/api/sync/device-token`
- the access and refresh tokens
- the offline PIN verifier per user (Argon2id, desktop parameters)
- the installation id

Kept in one JSON file under the app's private documents directory (`expo-file-system`),
`app-state.json`, with fields:

- `appLockEnabled` (boolean)
- `lastForegroundAt` (ISO timestamp)
- `updateChannel` (`play` | `apk`)
- `lastVersionCheckAt` (ISO timestamp)

Sync values the desktop keeps through its ports (hub credentials, pull cursor, hub epoch) are
stored by the phone adapters behind the same ports that `sqliteContainer.ts` and
`syncUseCases.ts` use. Secrets go to secure storage and non-secret values to the same tables the
desktop uses. The exact port list is read from those two files in the first M1 task.

## Validation rules carried over (enforced by the shared use-cases, not by phone screens)

- Line value = `max(0, round2dp(qty × price − discountAmount))`. Total =
  `round2dp(subtotal − discount + tax + shipping)`.
- A party name is unique per company.
- Remaining kilograms are never below 0.
- A roll price is editable only before the roll's first sale (`assertRollPriceEditAllowed`).
- A write dated on a locked day or in a closed year is refused (`assertDayUnlocked`,
  `assertYearOpen`).
- A voucher amend goes through `replace`, in one transaction.
- USD and SYP are never summed.
