# Corrective Action Plan — Sync & Inventory (14 reported problems)

- **Date:** 2026-10-07
- **Code base investigated:** branch `clean-desktop-release` @ `91926eeb` (desktop 2.0.2), Render test hub `ME` @ `7314c174`
- **Phase:** investigation and plan only. **No code was changed for this document.**

## 0. How this was investigated

| Source | What was read | Access |
|---|---|---|
| Source code | frontend (`src/…`), backend (`backend/src/…`), sync push/pull/materialize, inventory count, year closing, inventory UI | read |
| Hub database (Render Postgres `motard-sync-test1`) | `sync_inbox` rows that are not `applied`, `parties`, `colors`, and the indexes on `parties` | **read-only** SQL |
| The owner's installed desktop app (`%LOCALAPPDATA%\motard-erp\logs\erp.1.log`) | sync-related log lines, intervals between `/api/sync/run` calls, hub connect errors, number collisions | read-only. The database was **not** opened |
| Two-device harness (`state-parity2.mjs`, run on 2026-10-07 against the hub) | timing and behaviour of real push/pull between two SQLite devices | test devices only |

Each problem below is first **verified against the project**. The verdict says whether the description is accurate, partly accurate, or technically different from what the code does.

---

## 1. Summary

| # | Problem (as reported) | Verdict | Layer(s) | Priority |
|---|---|---|---|---|
| 1 | Sync delay between devices | **Confirmed.** It is caused by the design (polling only, no push when you save) and the hosting (free hub sleeps) | sync design, frontend scheduler, hub hosting | P1 |
| 2 | Data does not refresh while the app stays open | **Confirmed, with several contributing causes.** Some only appear after a restart | frontend state (module caches, memo deps), sync result accounting | P1 |
| 3 | No clear refresh button | **Partly accurate.** A «مزامنة الآن» button exists but does **not** refresh screen data | frontend UI | P1 |
| 4 | Inventory data cannot be edited as required | **Confirmed.** Editing is incomplete, hidden in a dialog, and one field is misleading | UI + business rules | P2 |
| 5 | Pieces are not an independently manageable field | **Confirmed, in a more precise form.** The data model has pieces per roll, but the UI forces 1 piece on create and shows the wrong figure | UI + business logic | P2 |
| 6 | A sync error stops synchronisation completely ("edit", 5 attempts, `sync/inbox`) | **Confirmed, root cause found.** Edits of colours/fabrics, and of parties renamed by a collision, are **guaranteed** to die. The device's ordered lane stalls while they retry | sync logic (device + hub), DB constraints | **P0** |
| 7 | An old/pending operation appears without new work | **Confirmed.** These are stuck retries and units recorded before pairing. The UI cannot explain them | sync logic + UI | P1 |
| 8 | Physical count and year closing are combined | **Confirmed.** It is one route, one page and one data model, and counts are tied to the financial year | IA + data model | P2 |
| 9 | Inventory page header takes too much space | **Confirmed** on the count page. Partly true on the stock tree | UI | P3 |
| 10 | Actions column is unclear | **Confirmed.** Two actions per row with a hidden required order | UI + workflow | P3 |
| 11 | Variance not shown clearly while typing | **Partly accurate.** It is shown live, but only in kg, against a moving base, with no pieces, value or totals | UI + business logic | P3 |
| 12 | Insufficient search and filtering | **Confirmed** on the count page (none at all). The stock tree has a search box with a stale-result bug and no filters | UI | P3 |
| 13 | Count, adjustments and closing are poorly organised | **Confirmed.** They are split across two nav groups and adjustments can't be created from their own page | IA + workflow | P2 |
| 14 | Inventory difference logic is wrong | **Confirmed. Six concrete defects**, including a 100-row cap that blocks year closing and future-dated movements | backend + frontend business logic | **P0** |

### Hidden problems found during the investigation (not in the original list, recorded separately)

| ID | Finding | Linked to |
|---|---|---|
| H1 | Colour and fabric edits send only `updatedAt` as the stale-check base (not `version`). The hub stamps its own time, so **every** edit after a sync is refused as stale | 6, 7 |
| H2 | When the hub or a peer renames a colliding number (`CUS-2026-0001 → CUS-2026-0001-6868`), the **originating device is never told**. Its next edit re-sends the old code and breaks the unique index | 6 |
| H3 | Retryable failures (stale base, unique-index violation) are retried 5× over ~100 s and then silently parked as `dead`. The edit then exists **only on the editing device** (silent divergence) | 6 |
| H4 | A colour edit carried a **1.17 MB** `updateInput` (embedded base64 image) through sync | 1, 6 |
| H5 | Units that were already applied and are re-pulled count as `applied`. While any unit holds the pull cursor, every 20 s cycle reports "data changed" and refetches **every** query | 2 |
| H6 | `syncCoverage.ts` says devices converge on year status "by pulling `financial_years`". **No such pull exists**: a year closed on PC-A stays open on PC-B | 8, 13 |
| H7 | One count row per (year, roll). A posted roll can never be re-counted (the error text says "void first", but no void exists) | 8, 14 |
| H8 | Roll rows show `roll.pieces` (pieces at purchase) while colour/fabric totals show `remainingPieces`. The same screen contradicts itself | 5 |
| H9 | Roll edit lets the user change `initialKg` with no stock movement, so "initial" drifts from the entry invoice | 4 |
| H10 | Each page navigation remounts the sync hook and fires an immediate extra `/sync/run`. On the owner's PC, 52 of 199 runs came < 5 s after the previous one | 1 (load) |

---

## 2. Investigation per problem

### Problem 1 — Synchronisation delay between the two devices

**Exact problem.** An invoice or customer created on PC-A appears on PC-B only after a noticeable delay.

**Where.**
- `src/presentation/hooks/useAutoSync.ts` — `PERIODIC_SYNC_MS = 20_000`. This is the only steady trigger.
- `backend/src/presentation/routes/sync.route.ts` — `runSyncCycle` (push, then pull) and `startBackgroundSync(20_000)`.
- `backend/src/application/use-cases/sync/syncUseCases.ts` — `runLocalSyncPush` lanes (`ORDERED_LANE_TYPES`, l. 295–318) and the ordered-lane stop (l. 579–594).
- Hub hosting: Render **free** web service (sleeps after idle; cold start ~1 min).

**Evidence.**
1. No code path pushes when a document is saved. `grep runSyncNow` finds only the 20 s timer, the reconnect effect, the status-bar button and the settings page.
2. Delivery therefore needs the sender's next tick (0–20 s) **plus** the receiver's next tick (0–20 s): up to ~40 s in normal conditions.
3. Owner's log (`erp.1.log`, last 200 runs): average gap 13.6 s, maximum 28.2 s. The cadence is as designed.
4. Owner's log shows `Connect Timeout Error (me-sh6t.onrender.com:443, timeout: 10000ms)` three times in 40 s and `getaddrinfo ENOTFOUND`. While the free hub wakes up, whole cycles fail and the next one is 20 s later.
5. Ordered lane: parties, fabrics, colours, rolls, invoices, returns, ledger, cashbox and settings all share **lane 0**. One unit that the hub accepts but cannot apply yet (`"hub accepted but not yet applied — retrying"`) counts as `failed`. It holds every later lane-0 unit until the next run, and the drain loop (`while … push.failed === 0`) also stops.
6. H4: a 1.17 MB colour payload is re-sent on every retry, which slows each cycle.

**Root cause.** Several timing causes add up:
- the design is poll-only (20 s on each side) and never pushes on save;
- head-of-line blocking in the single ordered lane;
- a hub that sleeps when idle;
- oversized payloads.

It is **not** a bug in a single function.

**Affected.** Sync engine (device and hub), UI scheduler, hosting, problems 2, 6 and 7.

**Dependencies.** Partly depends on Problem 6: until stuck units stop blocking lane 0, a faster schedule only retries the blocker faster.

**Risks.**
- More frequent polling increases hub load and battery/network use.
- Push-on-save must not run two cycles at once. The per-tenant run lock (`runSyncCycle`) and `state.running` already serialise this, so reuse them.
- Relaxing ordering can reintroduce the documented "sale overtakes purchase" bug (comment at l. 304–308).

**Recommended correction.**
1. **Push on save:** after any successful write that enqueues a unit, schedule a debounced (≈1.5 s) `runSyncNow`. Reuse the existing one-run-at-a-time guard.
2. **Fast change check on the receiver:** add a cheap hub endpoint such as `GET /sync/changes?afterSeq=` that returns only the latest `applied_seq`. Poll it every 3–5 s and run a full pull only when it moved. Keep the 20 s full cycle as a backstop.
3. **Lane blocking:** a hub *materialisation* deferral (the hub stored the unit in its inbox) is **delivered**. It must not block later units on the device, because the hub already applies its inbox in `received_seq` order. Keep blocking only for transport failures (network, 5xx, timeouts).
4. **Payload size:** never send image data URLs in sync payloads (see H4 under Problem 6).
5. **Hosting (operations):** run the production hub on an always-on instance, or add a keep-alive. The free tier's sleep is a hosting limit, not a code bug.
6. H10: fire the immediate run only once per app session, not on every page remount.

**Verification.**
- Extend `state-parity2.mjs` with a latency probe: create an invoice on A, then poll B every 500 ms until it appears. Record p50/p95 over 20 trials, before and after. Target p95 ≤ 8 s with a warm hub.
- A unit test proves that a hub "accepted, not applied" response no longer stops the lane.
- Re-run the existing sale-after-purchase ordering test (two devices) to prove no regression.

**Priority / order:** P1, step 6 in §4 (after the Problem 6 fixes).

---

### Problem 2 — Data does not update inside the open program

**Exact problem.** Received data is sometimes not shown until the program is closed and reopened.

**Where.**
- `src/presentation/hooks/useAutoSync.ts` l. 93–130 (refresh decision).
- `src/components/layout/SyncStatusBar.tsx` l. 49–58 (manual sync: invalidates only `SYNC_HUB_KEY`).
- `src/routes/settings.sync.tsx` l. 177–200 (manual sync: `qc.invalidateQueries()` but **not** `refreshParties()` / `refreshInventory()`).
- `src/presentation/hooks/useParties.ts`, `useInventory.ts`, `useSettings.ts`, `useCurrency.ts` — module-level stores outside react-query that mutate the same arrays in place (`splice`).
- `src/routes/inventory.tsx` — `useMemo(…, [q, fabrics.length])`.
- `backend/src/application/use-cases/sync/syncUseCases.ts` l. 916–918 (re-pulled `applied` units counted as `applied`).

**Evidence.**
1. The periodic tick refreshes screens only when `localDataVersion` changed or `pull.applied > 0`. That path calls `refreshParties()`, `refreshInventory()`, `loadSettings()` and `qc.invalidateQueries()`, which is correct. **But:**
   - The **status-bar «مزامنة الآن»** pulls data and refreshes nothing on screen. The user sees a success toast while the screen stays old until the next tick picks up the version change (≤ 20 s), or until a restart.
   - The **settings-page sync** refreshes react-query but not the parties/inventory module stores. Customer pickers, the inventory tree and every name looked up from those caches stay stale.
   - `useCurrency` is a module store that is **never** refreshed by sync.
2. The inventory search memo depends on `fabrics.length`. A rename, or a new colour or roll under an existing fabric, doesn't change the length, so search results stay stale. The stores mutate their arrays in place, so array identity never changes. Every memo keyed on these arrays has the same flaw.
3. Forms and detail views copy data into local `useState` when they open, for example `RollFormDialog` and `RollAdjustSection` (`useState(String(roll.remainingKg))`). They never see later changes, which the user perceives as stale data.
4. H5: while a unit holds the pull cursor, re-pulled already-applied units count as `applied`. Every cycle bumps `localDataVersion` and invalidates **all** queries every 20 s. That isn't staleness, but it causes constant refetching and flicker, and hides real changes in the noise.
5. Problems 1 and 6 also feed this: while the lane is stalled the data really hasn't arrived. A restart fires an immediate cycle on mount and reloads everything, so "restart fixes it" is often just "the next cycle happened".

**Root cause.**
- There is **no single "refresh all data" function**. Three call sites each refresh a different subset.
- The module-level stores mutate in place, which defeats React memoisation.
- Open dialogs snapshot data.
- Change detection on the backend over-reports (H5).

**Affected.** Every screen reading the parties, inventory, settings or currency stores; the sync status bar; the settings sync page.

**Dependencies.** Problem 3 needs the same refresh function. Problem 6/H5 change detection should be fixed first so a refresh means real new data.

**Risks.**
- A full refresh while a form is open must not discard the user's input. Refresh lists and caches, never the form state.
- Too many refetches load the local server on large datasets. Keep refresh signal-driven, not timed.

**Recommended correction.**
1. Create one `refreshAllData()` in `src/lib/sync-engine.ts`. It refreshes the parties, inventory, settings and currency stores, then `qc.invalidateQueries()`. Call it from the periodic tick, the status-bar button, the settings sync button and the new refresh button (Problem 3).
2. Backend: add a `changed` counter that counts only `created` units (and rejections rolled back locally). Bump `localDataVersion` only on real changes. Keep `applied` for reporting.
3. Replace in-place `splice` with a new array plus a version bump, or key every memo on the store version (`useInventory()` / `useParties()` already return the version). Fix `inventory.tsx` first.
4. Open edit dialogs: when the underlying row's version changes while the dialog is open, show "تغيّرت هذه البيانات على جهاز آخر — إعادة تحميل" instead of saving silently against stale values. The roll adjustment path already uses `expectedVersion`.

**Verification.**
- Unit test: after a simulated pull with `created > 0`, `refreshAllData` is called once. With only re-pulled `applied`, it is not called.
- Two-device harness: rename a fabric on A, then assert that B's inventory search for the new name finds it within one cycle without reload. Do the same for a new customer appearing in B's sale-invoice customer picker.
- Manual: press «مزامنة الآن» and confirm the open list updates immediately.

**Priority / order:** P1, step 7 in §4.

---

### Problem 3 — No clear refresh button

**Exact problem.** When changes don't appear, the user must restart the program.

**Where.** `src/components/layout/SyncStatusBar.tsx` (shown only when a hub is paired). `src/components/dashboard/Header.tsx` (no refresh control).

**Evidence.**
1. A «مزامنة الآن» button **does exist**, above each page's content, but only when the device is paired (`if (!hub?.url) return null`).
2. Its click handler runs sync and invalidates only the sync status (`SYNC_HUB_KEY`). No list or screen data is refreshed (see Problem 2, evidence 1).
3. Unpaired or offline installs have no refresh affordance at all. A WebView has no visible browser reload, and F5 isn't advertised.

**Root cause.** The existing button is a *transport* button ("send/receive now") that never refreshes the screen. There's no *refresh-the-screen* control.

**Affected.** All screens.

**Dependencies.** Needs `refreshAllData()` from Problem 2.

**Risks.**
- A full `window.location.reload()` would drop unsaved forms and the session-scoped state. **Do not** use reload; use the data refresh.

**Recommended correction.**
- Add an always-visible «تحديث» button (icon + label) in the header with the shortcut F5 / Ctrl+R mapped to the same action. It runs `runSyncNow()` when paired, then always calls `refreshAllData()`, and shows "آخر تحديث: الآن".
- The status-bar button calls the same function, so there's one behaviour everywhere.

**Verification.** Manual and Playwright: change data through the API behind the UI's back, press «تحديث», and the list shows it. Pressing F5 does not reload the WebView.

**Priority / order:** P1, step 7 in §4 (same step as Problem 2).

---

### Problem 4 — Inventory data cannot be edited as required (add / decrease / modify)

**Exact problem.** Stock quantities cannot be fully added to, reduced or modified from the inventory page.

**Where.**
- `src/components/inventory/InventoryDialogs.tsx` — `RollFormDialog` (l. ~715–900) and `RollAdjustSection` (l. 630–713).
- `src/routes/inventory_.adjustments.tsx` — read-only log.
- `backend/src/infrastructure/repositories/sqlite/SqliteRollRepository.ts` l. 145–210 — `remainingKg` is refused on update, but `initialKg` is accepted.

**Evidence.**
1. A real adjustment exists (audit fix): `RollAdjustSection` sets new kg and pieces with a reason, through `/inventory/rolls/:id/adjust` and `applyRollAdjustment` (movement, P&L leg, audit, synced as `roll/adjust`). It is **only reachable** by opening a roll's *edit* dialog (pencil icon) and then pressing «تعديل الكمية / عدد الأثواب». Nothing on the tree or on «تعديلات المخزون» says it exists.
2. The adjustment input is "the new total". There's no direct "add X" / "subtract X" mode, which is how counters describe what they found ("3 more pieces", "2 kg damaged").
3. «تعديلات المخزون» lists history only (limit 200, no paging or filters) and has no "new adjustment" action.
4. H9: in the same edit dialog, «الكمية» edits `initialKg`. The backend accepts it with no stock movement (`values.initialKg = String(data.initialKg)`), so "initial" no longer matches the purchase or entry invoice. Users read it as "changing the stock", but stock does not move.
5. No adjustment exists at colour or fabric level (bulk), and there are no adjustment reasons/types (damage, found, count, sample).

**Root cause.**
- The feature exists in the backend but the UI exposes it only as a sub-section of the metadata edit dialog.
- The edit dialog mixes metadata (roll no., batch, supplier, price) with stock, and lets `initialKg` change outside the stock ledger.

**Affected.** Inventory tree, adjustments page, roll repository, stock movements, P&L legs, sync `roll/adjust`.

**Dependencies.**
- Problem 5: pieces must be editable in the same action.
- Problem 13: where the adjustment entry point lives.
- Problem 14: the count must post through the same `applyRollAdjustment`, which it already does.

**Risks.**
- Opening `initialKg` edits further would break COGS and entry invoices. The fix must **close** that hole, not widen it.
- Adjustments are financial (P&L leg at cost): they need role guards (who may adjust). The existing write guard is in place; confirm the role.

**Recommended correction.**
1. Add a dedicated «تعديل كمية» action on each roll row (and in a roll's detail). It is a dialog with a mode selector:
   - زيادة / نقص (delta)
   - تعيين الكمية (set total)

   Each mode has kg and pieces, a reason **type** (تلف · عيّنة · زيادة جرد · عجز جرد · تصحيح إدخال · أخرى) plus a free note, and a preview "قبل → بعد" for kg and pieces.
2. Add «تعديل جديد» on «تعديلات المخزون»: a roll picker (search) followed by the same dialog. Add paging and filters (date, roll, user, type) to that log.
3. Lock `initialKg` in the edit dialog once the roll has any movement other than its entry (`stock_movements` count > 1, or linked entry invoice). Show it read-only with "يُعدَّل من فاتورة الدخول". Reject it on the backend in the same case.
4. Keep `applyRollAdjustment` as the single write path. It already has version checks, the audit row, the movement and sync.

**Verification.**
- Backend tests: delta +/− and set modes produce the correct movement and ledger leg; negative results are refused; `initialKg` changes are refused after movements.
- Two-device harness: adjust on B by delta and see A converge (existing check 12, extended to delta mode).
- UI: the adjustment is reachable in ≤ 2 clicks from the tree and from the adjustments page.

**Priority / order:** P2, step 10 in §4.

---

### Problem 5 — Number of pieces is not an independently manageable field

**Exact problem.** Pieces should be a first-class stock quantity (increase, decrease, edit) next to kg.

**Verified model.** At **roll** level pieces already exist in the database: `rolls.pieces` (count at purchase) and `rolls.remaining_pieces` (current). Sales, returns, print send/receive and adjustments move `remaining_pieces`. The *fabric* table has no pieces column, and the fabric/colour totals are computed from rolls. So the description is accurate **for the UI**; the data model only needs completing.

**Where / evidence.**
1. `InventoryDialogs.tsx` l. 163 (fabric dialog creating its first roll) and l. 818 (roll dialog): `pieces: 1` is **hard-coded**. A roll created from the inventory page always has 1 piece, whatever the real count.
2. `InventoryRows.tsx` l. 265 and l. 334 display `roll.pieces` (pieces at purchase). Colour/fabric totals (`totalPiecesOfColor`, `useInventory.ts` l. 332) sum `remainingPieces`. After a sale of 3 pieces, the roll row still shows the purchase count while the colour total shows the remaining count (H8).
3. The page subtitle says «جميع الكميات محسوبة بالكيلوغرام», which tells users pieces don't count.
4. The count sheet (Problem 14) records **kg only**. `recordCount` is called without `countedPieces`, although the backend supports it.
5. The entry invoice does allow pieces (`invoices.entry.new.tsx` l. 1241), so purchases can record pieces correctly. Only manual creation from the inventory page is broken.

**Root cause.** The UI was built for kg. Pieces were added to the backend and to sale/entry/print documents, but the inventory page forms, roll row display and count sheet were not updated.

**Affected.** Inventory dialogs, roll rows, the count sheet, the adjustment dialog (which already has pieces), and reports showing pieces.

**Dependencies.** Problems 4 and 14 (same dialogs and sheet). An owner decision is needed, see Risks.

**Risks / decision needed.**
- "Pieces in fabric data" could mean a separate fabric-level counter. **Not recommended:** it would be a second source of truth beside the rolls, and every sale would need to update both. Recommended: pieces stay per roll and fabric/colour totals stay derived, with full create/adjust/count/display support. **Owner to confirm.**
- Existing rolls created with the forced `pieces = 1` hold wrong data. Correct them through the new adjustment (auditable), not a silent migration.

**Recommended correction.**
1. Roll create (both dialogs): a required «عدد الأثواب» input (integer ≥ 1). Send it as `pieces`; the backend sets `remaining_pieces = pieces`.
2. Roll rows: show «متبقٍ X من Y أثواب» (`remainingPieces` / `pieces`), consistent with the totals.
3. Change the subtitle so it doesn't claim kg only.
4. The count sheet and the adjustment dialog carry pieces (Problems 4 and 14).
5. One-time report «لفات بعدد أثواب = 1 أُنشئت يدوياً» so the owner can correct legacy rows with adjustments.

**Verification.**
- Unit/UI test: creating a roll with 12 pieces gives `pieces = remaining_pieces = 12`.
- Sell 3, and the row shows 9/12 and the colour total includes 9.
- Two-device: the roll create with pieces converges (the roll snapshot already carries pieces).

**Priority / order:** P2, step 9 in §4.

---

### Problem 6 — A sync error causes synchronisation to stop completely

**Exact problem (as seen by the user).** A notification says the hub stopped a unit permanently after 5 failed processing attempts. The unit is an `edit` (`update`) and the notification points to `sync/inbox`.

**Where.**
- Notification text: `syncUseCases.ts` l. 481–500: «أوقف المركز وحدة مزامنة نهائياً … راجع سجل الوارد على المركز (/sync/inbox)».
- Attempt budget: `MATERIALIZE_MAX_ATTEMPTS = 5` (`syncUseCases.ts` l. 48), on the hub (l. 1502) and the device (l. 1001).
- Stale-base checks: `syncMaterialize.ts` l. 1348–1402 (masters) and l. 556–598 (invoices).
- Colour/fabric update enqueue: `backend/src/presentation/routes/color.route.ts` l. ~120–130 and `fabric.route.ts` l. ~121–130. They pass `{ updatedAt }` only. `party.route.ts` and `roll.route.ts` pass `{ version }`.
- Number-collision renaming: logged as `sync number collision: incoming/existing record renamed`.

**Evidence (live hub database, read-only).** These are the `sync_inbox` rows that are not applied:

| Device | Entity | Operation | Attempts | Error |
|---|---|---|---|---|
| «-» 37a52598 (owner) | colour `10f9becd` | update | 5 → **dead** | `stale base: hub row changed, rebase the edit` |
| «Bashar» a3aa8610 | colour «اسود» `e68a4d9f` | update | 5 → **dead** | same |
| «Bashar» a3aa8610 | party «علي» `6868c643` | update | 5 → **dead** | `Failed query: update "parties" set "code" = CUS-2026-0001 …` |
| test device b4954d8b | roll | adjust | 1 → dead | `unsupported sync unit roll/adjust` (old hub; fixed by `9737cc9e`) |

Measurements on those rows:
- Colour «اسود»: the device's base `updatedAt` was `13:20:47` (its own clock at creation). The hub row `updated_at` is `18:23:39`, when the hub applied the create five hours later. **These can never match**, so the first edit after any sync is refused as stale every time (H1).
- Colour `10f9becd`: created on test device A at 17:34:33 hub time. The owner's device received it via pull and stored its own apply time (17:54:25) as `updatedAt`. Same failure.
- Party «علي»: the hub has `CUS-2026-0001` (another device's customer) **and** «علي» stored as `CUS-2026-0001-6868` after a collision rename. The owner's log shows the same rename locally (`incomingId 6868c643 … from CUS-2026-0001 to CUS-2026-0001-6868`). The originating device «Bashar» still has `CUS-2026-0001`. Its edit sends the full `updateInput` including `code: "CUS-2026-0001"` and violates `parties_tenant_id_code_key (tenant_id, code)`. The raw SQL error is classified as retryable, so it ran 5×, then died (H2, H3).
- The colour update payload is **1,176,993 characters**. `updateInput.imageUrl` is a 1.17 MB data URL (H4).

**What "stops completely" really means.**
- The hub parks **one unit** as dead. Sync as a whole continues afterwards.
- **But** for the ~5 cycles before that (about 100 s), the device gets "hub accepted but not yet applied — retrying" back for that unit. That unit is in **ordered lane 0**, so every later party, fabric, colour, roll, invoice, return, ledger, cashbox and settings unit from that device is held «بانتظار إرسال عملية سابقة لها» (`syncUseCases.ts` l. 579–594). To the user, sync has stopped.
- **After** the unit dies, the edit exists only on the editing device. The other devices never get it, and nothing reconciles it: **silent divergence** (H3).

**Root cause.**
1. **H1:** colour and fabric edits use a timestamp base. Timestamps are written by each node's own clock and apply time, so they never agree across nodes. Both tables have a `version` column that the route ignores.
2. **H2:** collision renames are applied on the hub and on receiving peers but never sent back to the origin. Edits send unchanged identity fields (`code`) back to the hub.
3. **H3:** the materialiser treats conflicts that can never succeed (stale base, unique violation) as *retryable* `failed`. Five retries can't succeed, and the final state is a dead unit with no conflict record the user can act on.
4. The ordered lane turns one retrying unit into a device-wide stall.

**Affected.** All master-data edits (colour, fabric, party; roll uses `version` and is OK), the conflict screen (`/sync/conflicts`), notifications, Problems 1, 2 and 7.

**Dependencies.** None upstream. **This must be fixed first**: Problems 1, 2 and 7 depend on it.

**Risks.**
- Switching colour/fabric to `version` needs a convergent version on all nodes (hub-canonical `version` mirrored locally, as `alignPartyVersion` does for parties). Otherwise the next edit fails the same way.
- Sending only changed fields changes the update contract. The hub must still reject a stale base.
- Back-propagating renames rewrites a visible number on the origin device. Users must be told (notification «تم تغيير رقم … إلى … لتفادي التكرار»).
- Existing dead units: their edits are lost on other devices. A re-push or recovery step is needed (see the plan).

**Recommended correction.**
1. `color.route.ts` and `fabric.route.ts`: pass `{ version: before.version }` like party/roll. On pull, align the local `version` to the hub's (generalise `alignPartyVersion` to colour, fabric and roll). Keep the `updatedAt` comparison only for payloads that genuinely lack a version, and compare it only against a hub-canonical value that the hub sends back.
2. Updates send only **changed** fields (diff `updateInput` against `before`). Identity fields (`code`, `number`) are never sent unless the user changed them.
3. Rename feedback: when the hub renames an incoming record, the push ack returns `{ renamed: { field, from, to } }`. The origin device applies it locally and notifies the user. Peers already rename on pull.
4. Classification: stale base and unique-index violations become **conflicts** (`status: conflict`, HTTP 409 to the device, a row in `/sync/conflicts` with both versions and "keep mine / keep theirs"), not retryable failures. Raw SQL errors map to the existing `userFacingErrors` messages, never `Failed query: …`.
5. The ordered lane is not blocked by hub-side deferrals (also Problem 1, item 3).
6. Payload hygiene: strip `imageUrl` data URLs from sync payloads. Upload images separately, or reject data URLs over a size cap with a clear message. Cap a unit's payload (for example 256 KB) at enqueue time.
7. Recovery for existing dead units: a hub admin action «إعادة المحاولة بعد الإصلاح» re-queues dead `update` units for re-materialisation after steps 1–4 are deployed. The device sends a fresh version-based edit for its local state («إعادة إرسال تعديلاتي»).

**Verification.**
- Backend tests (SQLite and PG):
  - (a) edit a colour created on another node: it applies on the first attempt;
  - (b) edit a party after a collision rename: the code is not sent and the update applies;
  - (c) concurrent edits on two nodes: one wins and the other becomes a **conflict row**, never dead after 5 retries;
  - (d) a 1 MB image is refused or stripped at enqueue.
- Two-device harness: add scenarios "edit colour after sync" and "edit renamed party" to `state-parity2.mjs`; both devices must end identical.
- Hub SQL check after the run: `SELECT count(*) FROM sync_inbox WHERE status='dead' AND received_at > <run start>` = 0.

**Priority / order:** **P0**, steps 2–4 in §4.

---

### Problem 7 — An old or pending operation appears with no new work

**Exact problem.** A pending sync operation shows up although the second device wasn't connected and no new operation was added.

**Where.**
- `backend/src/application/use-cases/sync/syncEnqueue.ts` l. 13: `isSyncEnqueueEnabled() { return true; }`. Every write is enqueued, paired or not.
- `syncUseCases.ts` l. 523–528: a unit the hub accepted but did not apply is reset to `pending` with «hub accepted but not yet applied — retrying».
- `sync.route.ts` l. 290–335: `/sync/hub` status returns `pendingCount`, `oldestPendingAt`, `lastPushError`.
- `SyncStatusBar.tsx` shows «N بانتظار الإرسال».

**Evidence.**
1. Units are recorded from install day, **before pairing**, by design (offline-first). When a device is paired, its whole history is pending until pushed. The UI calls these «بانتظار الإرسال» with no age or origin.
2. Units stuck as in Problem 6 stay `pending` and are re-sent every cycle while the user does nothing. The hub's `apply_attempts` rises on each re-send: the owner's colour edit went from received at 07:16:42 to dead at 07:18:02, 80 s later. Pending units also don't need a second device: the device pushes to the **hub**, which is always there.
3. Units held behind a blocked unit show «بانتظار إرسال عملية سابقة لها», again without saying which unit blocks them.
4. There is no screen listing pending units (type, document, age, last error). Only a count.

**Root cause.**
- The UI shows a count with no context.
- Stuck units retry indefinitely (until the hub's 5-attempt death) without the user being told what they are.
- The pending queue legitimately includes pre-pairing history, which looks like phantom work.

**Affected.** Status bar, header badge, sync settings page.

**Dependencies.** Problem 6 removes the main cause of stuck units. Problem 3/2 for the refresh behaviour.

**Risks.** Showing raw payloads would expose technical noise. Show a business description only (document type and number, party name).

**Recommended correction.**
1. Add a «العمليات المعلّقة» panel (opened from the status bar count). It lists each pending/failed unit in plain words: «تعديل لون: اسود», «فاتورة بيع INV-…». Each row shows the age, the reason (via `describeSyncProblem`) and, for held units, «تنتظر: <blocking unit>».
2. Mark units recorded before pairing («سُجّلت قبل ربط الجهاز») so a large first push is understood.
3. Dead or rejected units appear in the same panel with an action (open conflict, re-send, dismiss after review).

**Verification.**
- With a stuck unit (Problem 6 scenario, before the fix), the panel names it and the held units point to it.
- After the Problem 6 fix, the same scenario shows nothing pending after one cycle.

**Priority / order:** P1, step 5 in §4.

---

### Problem 8 — Physical count and year closing are combined

**Where.**
- `src/routes/closing.tsx` (one route `/closing`, title «إقفال السنة المالية والجرد»): count sheet, closing stats, checklist and close/reopen are on one page.
- Backend: `year-closing.route.ts` serves both `/financial-years/count-sheet|counts|counts/post` and `/financial-years/close`.
- Table `inventory_counts` (`year`, `roll_id`, …): no session, no date, one row per (year, roll).

**Evidence.**
1. A count can only be started as «بدء الجرد» of a **financial year**, which sets the year status to `counting`. There's no mid-year count (monthly, spot check, per fabric).
2. H7: `recordCount` overwrites the single row for (year, roll), and a posted row can't be re-counted. The error says «ألغِ التسوية قبل إعادة العدّ», but **no void endpoint or function exists** (`grep voidCount|unpost` finds nothing).
3. H6: the year status is device-local. `syncCoverage.ts` claims convergence "by pulling financial_years", but no such pull exists. A year closed on PC-A is open on PC-B, and PC-B can still post into it.

**Root cause.** The count was designed as a *step of year-end closing*, not as an independent stock operation. The data model (keyed by year), the route and the page reflect that.

**Affected.** Count sheet, year closing, stock movements dated by count, multi-device closing state.

**Dependencies.** Problem 13 (where the pages go) and Problem 14 (count logic). H6 is a closing-correctness issue that must be fixed when separating.

**Risks.**
- Separating must keep the closing rule "no unposted variance at year end", now defined over count *sessions* dated in that year.
- Migrating existing `inventory_counts` rows into the new model: map each year to one session.
- The financial-year sync (H6) is tenant-wide and hub-authoritative. Get the design right: a hub endpoint for year status, pulled into every device. Don't replay closes as units.

**Recommended correction.**
1. New model: `inventory_count_sessions` (id, date, scope (all / fabric / colour), status: open → counted → posted/cancelled, created_by), with `inventory_counts.session_id` replacing `year` as the key. Unique (session, roll). Several sessions per year are allowed, each roll at most once per *open* session.
2. A void for a posted count line becomes a reversing `applyRollAdjustment`, so history is kept.
3. Year closing *reads* counts: the blocker becomes "a session dated in this year has unposted variances". Closing no longer starts counts.
4. H6: implement hub-authoritative year status (`GET /financial-years` on the hub, pulled by every device each cycle; local writes refused for a year closed on the hub). Fix the misleading comment in `syncCoverage.ts`.

**Verification.**
- Migration test: existing year rows become sessions; preview blockers are unchanged.
- Two sessions in one year on the same roll both post.
- A posted line can be voided, giving a reversing movement and an audit row.
- Two-device: close on A, then B refuses a sale dated in that year after one cycle.

**Priority / order:** P2, step 11 in §4.

---

### Problem 9 — Page design takes too much space before the table

**Where / evidence.**
- Count page (`closing.tsx`): the count table comes **after** a 4-stat card grid (`sm:grid-cols-2 lg:grid-cols-4`) and the checklist card. The table itself is capped at `max-h-[50vh]`, so on a laptop screen less than half the height is for counting.
- Stock tree (`inventory.tsx`): a search card, then a list capped at `max-h-[65vh]`, plus the shell header and the sync status bar above.

**Root cause.** Summary-first layout from the year-closing context. The table is treated as secondary.

**Dependencies.** Problem 8/13 (the count page is rebuilt in its own route). Problem 11 (the totals move into a compact bar).

**Risks.** Hiding totals entirely would remove useful progress information. Keep them in one line.

**Recommended correction.**
- Count page: one compact sticky bar (progress «عُدّ 120 من 340», total gain/loss kg and pieces, post button), with the table filling the rest of the viewport (`flex-1`, no fixed `50vh`) and sticky column headers. Year-closing stats live only on the closing page.
- Stock tree: merge search and filters into the page header line. Remove the inner `max-h` and let the page scroll.

**Verification.** Visual check at 1366×768 and 1920×1080: at least 12 count rows visible without scrolling at 1366×768 (today ~5–6).

**Priority / order:** P3, step 13 in §4.

---

### Problem 10 — The actions column is unclear

**Where / evidence.**
- Count page column «إجراء»: «حفظ» (outline) and «ترحيل الفرق» (red, destructive). «ترحيل» is disabled until the line is **saved** and has a non-zero difference. The order is explained only in a tooltip («احفظ الكمية الفعلية أولاً، ثم رحّل الفرق»).
- A typed value that isn't saved still shows a difference, but «ترحيل» stays disabled, which looks broken.
- If stock moved after saving, «ترحيل» fails with «تغيّر رصيد هذه اللفة بعد الجرد» (Problem 14).
- A zero difference: «ترحيل» is disabled, which is correct, but the line stays "counted". The closing blocker ignores zero differences, so this is harmless, just unclear.
- Stock tree rows: three icon-only buttons (add child, edit, delete). The stock-quantity change is hidden in «edit» (Problem 4).

**Root cause.** The two-step document workflow (record count, then post variance) is pushed onto every row instead of being one deliberate review step.

**Dependencies.** Problem 14 (posting logic), Problem 11 (variance display), Problem 4 (adjustment action).

**Recommended correction.**
- Count rows: the physical count saves on blur/Enter (auto-save, with a per-row saved indicator ✓). No per-row post button. Add **one** page-level «مراجعة وترحيل الفروقات» that opens a review list (only lines with differences, kg/pieces/value) and posts them together in one transaction per line, reporting each failure.
- Tree rows: labelled actions in an overflow menu: «تعديل البيانات», «تعديل الكمية», «حذف». Add-child stays as a visible «+ لون» / «+ صبغة».

**Verification.** Usability check: a new user completes "count 3 rolls and post differences" without instructions. Unit test for the batch-post endpoint.

**Priority / order:** P3, step 13 in §4.

---

### Problem 11 — Variance not displayed clearly during entry

**Verdict.** Partly accurate: `closing.tsx` l. 366–401 **does** compute and colour the difference live while typing (draft − book). The real issues are below.

**Evidence.**
1. Kg only. Pieces are not entered or shown (Problem 5).
2. The book figure is **live** (`getCountSheet` returns the roll's current quantity for unposted lines), while the saved line's `diffKg` and the posting use the **snapshot at save time**. After a sale, the screen shows one difference, the stored line holds another, and posting refuses. The user can't tell which number is real.
3. No value (money) of the difference, no percentage, no running totals per fabric or for the page while typing (the totals in the header reflect *saved* lines only).
4. An empty input means "not counted". Typing `0` is a real zero count, but the two look alike at a glance.

**Root cause.** Display logic and posting logic use different book bases. Only the kg dimension was implemented in the UI.

**Dependencies.** Problem 14 (one basis), Problem 5 (pieces).

**Recommended correction.**
- Show «الدفتري عند العدّ» (the snapshot) and, if the roll moved since, a warning chip «تحرّك الرصيد منذ العدّ: −3 كغ».
- The difference columns hold kg and pieces, plus the value at cost (`round2dp(diff × pricePerKg)`, per currency, never mixed). Colour: green for a gain, red for a loss.
- A sticky totals row (page and filter scope): gains and losses in kg, pieces and value.
- An uncounted line shows «غير معدود» as a placeholder; a typed `0` shows a red «0 (عجز كامل)».

**Verification.** Unit tests for the variance calculator (kg, pieces, value, snapshot vs live). UI test: type values and totals update immediately.

**Priority / order:** P3, step 13 in §4.

---

### Problem 12 — Insufficient search and filtering

**Evidence.**
- Count page: **no search, no filter, no paging control.** Only the first 100 rolls are fetched (Problem 14 #1).
- Stock tree (`inventory.tsx`): a search box covers fabric, colour name/code, roll no. and dye batch. **But:**
  - its memo depends on `[q, fabrics.length]`, so results go stale after edits from sync (Problem 2);
  - it paginates fabrics only (10 per page);
  - there are no filters for supplier, stock state (empty / low / has stock), entry date or currency;
  - a matching roll is found only by expanding its fabric and colour.
- Adjustments log: no search or filters, limit 200 (Problem 4).

**Root cause.** The count sheet was built as a single-page list. The tree search was built over the client cache without filter dimensions and with an incorrect memo dependency.

**Dependencies.** Problem 14 (server-side paging/filters for the count sheet), Problem 2 (memo fix).

**Recommended correction.**
- Count sheet API: `q` (fabric / colour / code / roll no. / batch), `fabricId`, `colorId`, `status` (uncounted / counted / variance / posted), with keyset paging that stays correct under filters. UI: a search box, the filter chips «غير معدود · معدود · فيه فرق · مرحّل», and «تحميل المزيد» / infinite scroll.
- Tree: filters for supplier, stock state and currency. A roll-number match auto-expands its fabric and colour and highlights the roll.
- Adjustments log: date range, roll, user, type.

**Verification.**
- Seed 1,000 rolls (existing `volume.mjs` harness) and find roll `#4711` in ≤ 1 s from each page.
- The filter «فيه فرق» shows exactly the lines with a non-zero difference.

**Priority / order:** P3, step 13 in §4 (count-sheet API in step 12).

---

### Problem 13 — Organisation of count, adjustments and closing is unclear

**Evidence (navigation, `AppShell.tsx` l. 45–90).**
- «المخزون» and «تعديلات المخزون» are under «القائمة الرئيسية».
- The physical count is under **«المحاسبة» → «إقفال السنة والجرد»**.
- «تعديلات المخزون» is a read-only log. Creating an adjustment is only possible inside the roll edit dialog (Problem 4).
- Results of the count (posted variances) appear in «تعديلات المخزون» as «تسوية جرد», but there's no link back to the count.

**Root cause.** The pages were added incrementally: count with closing (accounting), adjustments with the audit fix. No workflow-oriented information architecture was ever defined.

**Dependencies.** Problem 8 (data separation), Problem 4 (adjustment entry point).

**Recommended correction.** One «المخزون» group with:
- «المخزون» (stock tree)
- «الجرد الفعلي» (`/inventory/count`, sessions list and count sheet)
- «تعديلات المخزون» (log plus «تعديل جديد», each row linking to its source: count session or manual)

«إقفال السنة» stays under «المحاسبة» and shows the count status as a **prerequisite card** linking to «الجرد الفعلي». Role visibility in `useSettings.ts` (`/closing`, `/inventory`) is updated for the new routes.

**Verification.** Nav test: each route is reachable, role permissions are unchanged for existing roles, and links from adjustment rows open the right count session.

**Priority / order:** P2, step 11 in §4 (same step as Problem 8).

---

### Problem 14 — Inventory difference logic is wrong

**Six confirmed defects** (`backend/src/infrastructure/repositories/sqlite/helpers/inventoryCountRepository.ts` and its PG twin `inventoryCountRepository.ts`, plus `src/routes/closing.tsx`):

| # | Defect | Evidence | Effect |
|---|---|---|---|
| 14.1 | **Only the first 100 rolls are ever shown** | Server `limit` defaults to 100 (`getCountSheet` l. 63). The UI calls `getCountSheet(year)` once and never uses `nextCursor` (comment: "One page only"). | Rolls 101+ can't be counted. The closing blocker «الجرد غير مكتمل: X من Y» can **never clear**, so a tenant with > 100 rolls can't close the year. |
| 14.2 | **Variance movements are dated 31 Dec of the count year** | `postCountVariance` l. 300: `date: \`${count.year}-12-31\`` | A count in October creates a stock movement and P&L leg **in the future**. Reports "to date", day locks and cashbox-by-date see entries dated after today. |
| 14.3 | **Display basis ≠ posting basis** | Sheet shows `counted − live book` (l. 118–123); post uses `counted − snapshot` and refuses if the roll moved (l. 286–293) | The screen shows a difference that will not be posted, then a refusal. |
| 14.4 | **Pieces are never counted** | UI sends `countedKg` only. In `postCountVariance`, `deltaPieces` = `countedPieces − live remainingPieces`, which is always 0 because `countedPieces` is null | Pieces drift is never corrected by a count. |
| 14.5 | **Rolls with 0 kg are excluded** | `base` filter `remainingKg > 0` (sheet l. 67 and preview `rollsInYear`) | Stock found on a roll the system thinks is empty can't be recorded. The same goes for rolls with 0 kg but pieces > 0. |
| 14.6 | **One count per roll per year, no void** | Lookup by (tenant, year, roll); a posted line throws «ألغِ التسوية…», but no void exists | Wrong postings can't be corrected through the count; a second count in the year is impossible. |

**Root cause.**
- The count was coded as a year-end, single-pass, kg-only, one-page feature.
- The live-book change (audit item 9: "difference = actual − *current* book") was applied to the **display** but not to the **posting** rule.
- The date was hard-wired to year end.

**Affected.** Stock quantities, the stock ledger, P&L (inventory expense legs), year closing, sync (`roll/adjust` carries the delta and date).

**Dependencies.**
- 14.1 and 14.6 are resolved structurally by Problem 8's session model.
- 14.4 needs Problem 5's UI pieces.
- 14.2 and 14.3 are independent and should be fixed first.

**Risks.**
- **Existing posted counts dated 31 Dec of the current year (2026) are future-dated.** They need a data correction (re-date the movements and ledger legs to the posting date) through a migration with an audit row. They must not be deleted.
- Changing the posting basis to "live" without a check would let a sale between counting and posting be erased. **Keep the snapshot as the rule**, and make the UI show it (Problem 11). Optionally offer «إعادة العدّ» in one click when the roll moved.

**Recommended correction.**
1. 14.2: the movement date = the count's date (session date, or posting date when posting today). Add a migration to re-date existing future-dated count movements and legs, with an audit row.
2. 14.3: the snapshot basis everywhere. The sheet returns `bookAtCount` and `movedSinceCount`; the UI shows both (Problem 11).
3. 14.1: paging and filtering in the API and UI (Problem 12), and progress counts from the server.
4. 14.4: pieces in recordCount, the sheet and the post (`deltaPieces = countedPieces − bookPiecesAtCount`).
5. 14.5: include rolls with `remaining_kg = 0 OR remaining_pieces = 0` that had stock during the session's scope, optionally behind «إظهار اللفات الفارغة».
6. 14.6: sessions and void (Problem 8).

**Verification.**
- Backend tests:
  - (a) 250 rolls, and the sheet pages through all of them; closing is possible after counting all.
  - (b) a count posted on 2026-10-07 creates a movement dated 2026-10-07.
  - (c) a sale between count and post gives a refusal plus the UI flag; a re-count then posts.
  - (d) a pieces-only difference posts.
  - (e) a 0-kg roll counted at 5 kg posts +5.
  - (f) void, then re-count in the same session.
- Two-device: a posted count converges, including pieces and date (extend check 9/11 in `state-parity2.mjs`).

**Priority / order:** **P0** for 14.1–14.3, step 8 in §4. The rest comes with steps 9–12.

---

## 3. Dependency map

```
6 (sync correctness: H1 H2 H3 H4) ──► 7 (pending visibility) ──► 1 (latency) ──► 2/3 (refresh)
                                   └──────────────────────────► 1 (lane blocking)
14.2/14.3 (count date + basis) ──► 5 (pieces) ──► 4 (adjust UX) ──► 8/13 (sessions + IA, H6 year sync)
                                                                   └──► 14.1/14.4–14.6 ──► 12 (search API)
                                                                                         └──► 9/10/11 (count page UX)
```

- Sync work (6, 7, 1, 2, 3) and inventory work (14, 5, 4, 8, 13, 12, 9–11) are **independent tracks**. They meet only at `roll/adjust` sync, which already works (two-device check 12/12c passes).
- Every sync change must pass the two-device harness before release, because the hub must be redeployed **before** devices that send new payload shapes (the same rule as the `roll/adjust` rollout).

---

## 4. Final ordered corrective action plan

| Step | Track | What | Problems | Why this position |
|---|---|---|---|---|
| **1** | Sync | **Diagnostics first.** The device keeps a persistent sync-event log (push/pull result per unit, dead/conflict reasons), and a hub admin view of `sync_inbox` dead/conflict rows with plain descriptions. | 6, 7 (evidence) | Every later fix is verified with it. Today a dead unit is only visible by SQL on the hub. |
| **2** | Sync (hub+device) | **Fix the stale base for colour/fabric:** `version` base in `color.route.ts` / `fabric.route.ts`, and generalised version alignment on pull. | 6 (H1) | The most frequent guaranteed failure. Hub deploy first, then the devices. |
| **3** | Sync | **Edits send only changed fields; rename feedback to the origin device** (ack `renamed`, local apply and notification). | 6 (H2) | Removes the unique-violation deaths. Needs step 2's update contract. |
| **4** | Sync | **Classify unrecoverable failures as conflicts** (409, conflict row, user choice), map SQL errors to messages, add **payload size and image hygiene**, and run **recovery** for existing dead units. | 6 (H3, H4) | After 2–3, the remaining failures are real conflicts. They must reach the user, not die silently. |
| **5** | Sync + UI | **Pending-operations panel** (business description, age, reason, blocking unit, pre-pairing marker). | 7 | Uses step 1's data and makes steps 6–7 observable. |
| **6** | Sync | **Latency:** push on save (debounced), cheap change probe (3–5 s), lane not blocked by hub-side deferral, one mount trigger per session; **ops:** always-on hub. | 1 (H10) | Only safe after 2–4. Otherwise it just retries failing units faster. |
| **7** | Frontend | **`refreshAllData()`**, a real `changed` counter in the backend, memo keys on store versions, stale-dialog warning, and the **«تحديث» button / F5** wired to the same function. | 2, 3 (H5) | The refresh is meaningful once change detection is honest (H5 fix) and data arrives quickly (step 6). |
| **8** | Inventory (backend) | **Count logic quick fixes:** movement date = count date, plus a migration re-dating future movements; snapshot basis shown and enforced consistently; server progress counts. | 14.2, 14.3 | Data-correctness (future-dated ledger) is independent of the UI rework and must not wait. |
| **9** | Inventory | **Pieces as a full quantity:** required input on roll create, correct roll display, legacy-row report. | 5 (H8) | Needed by the adjustment dialog (10) and the count sheet (12). |
| **10** | Inventory | **Adjustment UX:** «تعديل كمية» per roll (delta/set, kg and pieces, reason types), «تعديل جديد» on the adjustments page, `initialKg` locked after movements, log paging/filters. | 4 (H9) | Reuses `applyRollAdjustment`, and gives counts and users one adjustment path. |
| **11** | Inventory (model + IA) | **Count sessions and separation from closing:** `inventory_count_sessions`, void posted line, closing reads sessions; new nav group (المخزون · الجرد الفعلي · تعديلات المخزون); closing keeps a prerequisite card; **hub-authoritative year status pull** (H6). | 8, 13, 14.6 | A structural change. It builds on 8–10 and resolves H6 together with the closing rework. |
| **12** | Inventory (API) | **Count sheet API:** search, filters, keyset paging under filters, include 0-kg rolls, pieces in record/post. | 12, 14.1, 14.4, 14.5 | Needs the session key from step 11. |
| **13** | Inventory (UI) | **Count page redesign:** compact sticky summary, full-height table, auto-save per row, one «مراجعة وترحيل الفروقات», variance kg/pieces/value with totals and moved-since flag, search/filter chips; tree actions menu and filters. | 9, 10, 11, 12 | Pure UI on top of the finished API and model. |
| **14** | All | **Release gate:** full backend (SQLite and PG) and frontend suites, two-device harness with the new scenarios (colour edit after sync, renamed-party edit, latency p95, count with pieces, year close on A refused on B), hub dead-unit query = 0, then version bump and installer. | all | Same verify-first, build-last rule as release 2.0.2. |

### Decisions needed from the owner before implementation
1. **Pieces (Problem 5):** confirm pieces stay **per roll** with derived fabric/colour totals (recommended), rather than a separate fabric-level counter.
2. **Production hub hosting (Problem 1):** an always-on instance instead of the free tier, which sleeps.
3. **Conflict policy (Problem 6):** for master-data conflicts, should the default suggestion be "keep the newest edit" or "always ask"? Recommended: always ask, since these are rare after steps 2–3.
4. **Future-dated count movements (Problem 14.2):** approve the migration that re-dates them to their posting date (audited, nothing deleted).
