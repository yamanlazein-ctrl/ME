# Execution plan — dye delete offline, roll price/grammage edit, entry-price hint (2026-10-29)

Branch: `feat/mobile` is the mobile spec branch → do this on a new branch off `main`/`feat/mobile` (ask owner). Nothing is committed unless asked.
Terms: "dye" (صبغة) = a **roll** row (`rolls`, `رقم الصبغة` = `dye_batch`). Corrective cascade purge = `DELETE /inventory/dyes/:id/purge` (a fabric).

## What the code says today (graph + source, verified)

| Topic                                                   | Fact                                                                                                                                                                                                                                                                                              | Where                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Delete block                                            | The "registered sync devices … unregister first" error is **only** the cascading dye _purge_: 409 `SYNC_DEVICES_ENROLLED` when the tenant has any non-revoked `sync_devices` row. Plain roll delete (`DELETE /inventory/rolls/:id`) has no such check and already enqueues `enqueueMasterDelete`. | `backend/src/presentation/routes/dye.route.ts:109-135`, `roll.route.ts:259` |
| Why it exists                                           | Audit N-05: purge is sync-exempt (`syncCoverage.ts:120` "hub-authoritative, not replayed per device"); running it on an enrolled device forks that device from the hub. Ledger is append-only (trigger dropped inside the purge tx).                                                              | `docs/MASTER-FORENSIC-AUDIT-2026-10-10.md:313`, `dyePurgeRepository.ts`     |
| The check is server-side, not client-connectivity-aware | The desktop's own SQLite holds the roster; "offline" is invisible to it.                                                                                                                                                                                                                          | `syncDeviceRepo.listForTenant`                                              |
| Roll edit dialog                                        | `pricePerKg` input is already editable in the edit dialog and sent via `updateRoll`; `weightGsm`/`widthCm` exist on `rolls` but are only settable in the **fabric create** dialog (`InventoryDialogs.tsx:156-171`, `334`) — not in roll edit.                                                     | `InventoryDialogs.tsx:~835-1010`                                            |
| Update route                                            | `PUT /inventory/rolls/:id` → `updateRollUseCase` → `enqueueMasterUpdate` (sync-safe, field diff + version). Need to confirm `updateRollSchema` whitelists `pricePerKg`/`weightGsm`/`widthCm`.                                                                                                     | `roll.route.ts:143`                                                         |
| Last entry price                                        | No endpoint/hook exists. `rolls.entry_price_per_kg/entry_currency/entry_date` (write-once) is the right source.                                                                                                                                                                                   | `roll.table.ts`                                                             |

## Step 0 — Reproduce before changing (UI)

1. Start isolated stack (memory: acceptance env / cert stack — never real data).
2. Reproduce: purge with an enrolled device → 409. Edit a roll created from an entry invoice → confirm whether price saves and why grammage cannot be changed. If "price locked" does not reproduce, report exact screen instead of guessing.

## Task 1 — Offline-safe dye deletion (**needs owner decision, see below**)

Options:

- **A (recommended, small):** Plain roll delete is already local + queued; make the purge guard apply only when the device is _actually the hub / reachable-enrolled with unsynced divergence_, and for an enrolled desktop route the action to the existing replicated path: delete rolls via `enqueueMasterDelete` per roll (only when the dye has no documents). Purge of a dye with invoices/ledger stays hub-only (financial history must not be silently dropped on one peer).
- **B (large, risky):** make the cascading purge a replicated operation (`dye/purge` op type, hub materializer + peer apply for invoices/ledger/cashbox rebuild, tombstones, conflict rules for documents edited elsewhere in the meantime). Reverses audit N-05, touches append-only ledger across devices. Needs its own design (+ PG and SQLite twins).
- **C:** leave as is.

## Task 2 — Roll price + grammage edit

1. Backend: add `weightGsm` (and `widthCm`) to `updateRollSchema`/`updateRollUseCase`; Postgres + SQLite repo twins; no migration (columns exist). Field diff already goes to the outbox.
2. Frontend: roll edit dialog gets `الكراماج (غ/م²)` input (DecimalInput, 2dp), prefilled from the roll; dedicated small "تعديل الكراماج" action on the inventory roll row (`InventoryRows.tsx`) opening a focused modal that calls the same `updateRoll`. Contract type + `useInventory` mapper include `weightGsm`.
3. Money: price goes through the existing path; no new rounding code (`round2dp`/`round4dp`).
4. Tests: backend (both engines) update persists + outbox payload; frontend dialog test.

## Task 3 — Last entry price hint (فاتورة دخول)

1. Backend: `GET /inventory/colors/:id/last-entry-price` (or fabric-level when only a fabric is chosen) → `{ pricePerKg, currency, entryDate } | null` from newest `rolls.entry_price_per_kg` for the colour (fallback: fabric). Read-only, both engines, read guard. No migration.
2. Frontend: `useLastEntryPrice(colorId)` (React Query, `staleTime`); in `invoices.entry.new.tsx` (price cell ~L1385) render a muted badge "آخر سعر: X" next to the input. Click on badge fills the field; **never** auto-writes or locks the field. Hidden when the line already has an identical price or no history. Currency shown from the record.
3. Tests: route test (latest wins, none → null), component test (badge shown, input untouched).

## Verification

- `npx vitest run`, `cd backend && DB_ENGINE=sqlite npx vitest run`, both `tsc --noEmit`, `npm run typecheck:sqlite`, lint (0 warnings), `prettier --check`.
- UI flows driven in a real browser against the isolated stack (Browserbase MCP is **not connected in this session**; the Claude-in-Chrome tools are the fallback unless the owner provides Browserbase).
- `graphify update .` afterwards; update `Status.md`/`Decisions.md` in the vault.

## Risks

- Task 1 B changes accounting-critical, append-only behaviour — do not start without approval.
- Run heavy suites one at a time (RAM ~7.7 GB).
