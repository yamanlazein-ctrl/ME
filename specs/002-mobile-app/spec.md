# Feature Specification: Motard ERP Mobile (Android v1)

**Feature Branch**: `feat/mobile` (to be created by the owner; Spec Kit has no branch hook in this repo)

**Created**: 2026-10-25

**Status**: Draft

**Input**: User description: "Create the feature spec for Motard ERP Mobile (Android v1) from docs/PRD-mobile.md — the PRD is the source of truth. Follow the constitution v2.0.0 strictly. Keep ALL IDs from the PRD unchanged (FR-01…FR-43, NFR-01…NFR-13, E1…E18, BC-1…BC-6, G1…G5). Every user story: priority (Must/Should/Could), independent test, Given/When/Then acceptance scenarios. Won't-have items listed as out of scope. Q1–Q5 stay as [NEEDS CLARIFICATION] with the PRD's recommended answer. No vague words, no application code, no tables."

**Sources**: `docs/PRD-mobile.md` (scope and IDs), `.specify/memory/constitution.md` v2.0.0 (rules), project brain notes Money Rules, Accounting Rules, Ledger, Sync, Sync Operations Runbook, Idempotency, Auth and Roles, Statements, Decisions, Open Issues.

**Reading guide**: requirement IDs (FR-xx, NFR-xx, E-x, BC-x, G-x) are the PRD's and are not renumbered. "Same as desktop" means the phone runs the identical business rule and validation as desktop 3.0.7 and produces the identical result (constitution Principle IV). The exact desktop operation behind each feature is listed in PRD §11.2.

## Clarifications

### Session 2026-10-25

- Q: How does the phone reuse the desktop's business and sync code (Q1)? → A: Import it in place from `backend/` behind an import boundary that bans server-only modules; no desktop file is moved in v1; extraction into a shared package (BC-6) happens after the pilot.
- Q: Which roles may record stock counts offline (Q2)? → A: Same as desktop: admin and accountant count offline; warehouse and viewer cannot record counts offline.
- Q: What number block sizes do phones reserve (Q3)? → A: Invoice 100; every other document type 50.
- Q: Does the hub already refuse a mismatched app version (Q4)? → A: Rule: verify in M0 and add BC-2 if absent. Verified 2026-10-25 in `backend/src/presentation/routes/sync.route.ts` and `backend/src/application/use-cases/sync/syncUseCases.ts`: no app-version check exists, so BC-2 is required.
- Q: Is the dark theme in v1 (Q5)? → A: No; deferred until after v1.

## User Scenarios & Testing _(mandatory)_

Priority scale: Must = required for v1 release; Should = in v1 if milestone M3/M4 is on time; Could = after v1 unless time remains. Within Must, P1 stories form the first usable slice (a phone that is enrolled, signed in, shows money, records cash and sells offline).

### User Story 1 - Enroll a phone and download the company data (Priority: Must, P1)

An admin creates an enrollment code on the desktop. A user installs the app, scans or types the code, and the phone joins the company as a new sync device, then downloads the full company data with visible progress.

**Why this priority**: nothing else works until the phone is a registered device holding the company data.

**Independent Test**: on a test hub with a seeded company of 10,000 documents, enroll a fresh phone with a desktop-issued code and compare record counts and party balances on the phone with the desktop.

**Acceptance Scenarios**:

1. **Given** a valid enrollment code shown on the desktop, **When** the user scans it (or types it) on a fresh install, **Then** the phone registers as a new device of that company and starts the first download.
2. **Given** the first download is running, **When** the user watches the screen, **Then** progress shows as a percentage and as a count of documents received.
3. **Given** the first download is interrupted by loss of network at 40%, **When** the network returns, **Then** the download resumes from where it stopped and does not restart from 0%.
4. **Given** the first download completed, **When** record counts and every party balance are compared with the desktop, **Then** they are identical.
5. **Given** an expired or already-used code, **When** the user enters it, **Then** enrollment is refused with an Arabic message saying the code is invalid, and no data is stored.

---

### User Story 2 - Sign in once, stay signed in, unlock with fingerprint (Priority: Must, P1)

After enrollment the user picks their name from the device's user list and enters their PIN, as on the desktop. The session lasts one year. Each time the app returns from the background after 60 seconds, or starts cold, it asks for a fingerprint (or the PIN as fallback).

**Why this priority**: every other story needs a signed-in user, and a phone is easier to lose than a desktop.

**Independent Test**: sign in, put the phone in airplane mode, background the app for 61 seconds, reopen, unlock with fingerprint, and confirm the user is still signed in.

**Acceptance Scenarios**:

1. **Given** an enrolled phone, **When** the app opens, **Then** an animated company-logo splash shows for at most 1.5 seconds, followed by the PIN picker listing the device's users.
2. **Given** a correct PIN, **When** the user signs in, **Then** the home screen opens and the user is not asked for the PIN again for one year, unless they log out, the hub refuses a session refresh, or the device is revoked.
3. **Given** the app was in the background for 60 seconds or more, **When** the user returns, **Then** the app content is hidden until fingerprint or PIN unlock succeeds.
4. **Given** the phone is offline and this user signed in online before on this phone, **When** they enter their PIN, **Then** sign-in succeeds with the same offline rights as the desktop.
5. **Given** the hub answers a non-refresh request with "forbidden", **When** the app receives it, **Then** the user stays signed in and only that action shows the error.

---

### User Story 3 - See today's money at a glance (Priority: Must, P1)

The home screen shows cashbox balance per currency, today's sales, total receivables and payables, pending sync count and the last successful sync time, plus quick actions allowed by the user's role.

**Why this priority**: the most frequent reason to open the app; proves local data and money display are correct.

**Independent Test**: seed known documents, open home offline, and compare each card's figure with the same figure on the desktop dashboard.

**Acceptance Scenarios**:

1. **Given** cash of 1,250.50 USD and 3,400,000 SYP, **When** the home screen opens, **Then** two separate cards show "1,250.50 USD" and "3,400,000 SYP", and no card shows a combined total.
2. **Given** a user with the viewer role, **When** home opens, **Then** no write quick action (new sale, receipt, payment, expense) is shown.
3. **Given** 4 units waiting to sync, **When** home opens, **Then** the sync chip reads "pending 4" and shows the last successful sync time.

---

### User Story 4 - Find a customer or supplier and read their statement (Priority: Must, P1)

The user searches for a party, opens it and sees its balance per currency, contact details, recent documents and the full statement in the desktop order with the desktop running balance. Admin and accountant can create and edit parties.

**Why this priority**: answering "how much does this customer owe" away from the shop is the owner's core need.

**Independent Test**: for a party with 650 statement rows, open the statement offline, scroll to the end and compare every row and the closing balance with the desktop statement.

**Acceptance Scenarios**:

1. **Given** 2,000 parties, **When** the user types three letters of a name, **Then** matching parties appear within 150 ms, most recently used first.
2. **Given** a party with 650 statement rows, **When** the user scrolls the statement, **Then** all 650 rows load in pages of 200 in the order date, creation time, document rank, id, and the closing balance equals the desktop's.
3. **Given** an invoice and its payment booked in the same transaction, **When** the statement shows them, **Then** the invoice row comes before the payment row.
4. **Given** an existing party named "أحمد", **When** an accountant creates another party named "أحمد", **Then** creation is refused with the desktop's duplicate-name message and the hint to use the "name — city" convention.

---

### User Story 5 - Record receipts, payments and expenses offline (Priority: Must, P1)

An admin or accountant records a receipt or payment (party, amount actually moved, currency, rate, optional write-off, optional invoice settlement), or an expense, with no network. They can cancel one or amend one; an amendment is a single replace operation.

**Why this priority**: collecting money in the market is the highest-frequency write.

**Independent Test**: in airplane mode record a receipt, amend it, cancel an expense; reconnect; confirm the hub and a desktop show the same vouchers, ledger entries and cashbox movements.

**Acceptance Scenarios**:

1. **Given** airplane mode, **When** an accountant saves a receipt of 500 USD from a customer, **Then** it is saved locally in one step, the customer balance and cashbox update at once, and the sync chip shows one more pending unit.
2. **Given** a payment that would make the USD cashbox negative, **When** the user saves it, **Then** the payment is saved and a warning states the resulting negative balance.
3. **Given** an existing receipt, **When** the user amends its amount, **Then** the original is cancelled and the new one created in one operation; if the app is killed during it, either both effects exist or neither does.
4. **Given** a receipt with a write-off of 20 USD, **When** it is saved, **Then** 20 USD is added to the party's settlement and the cash moved equals the entered amount only.
5. **Given** a warehouse user offline, **When** they open the add menu, **Then** receipt, payment and expense actions are not available.
6. **Given** a day locked on the desktop and pulled to the phone, **When** the user tries to record a receipt dated that day, **Then** it is refused with the desktop's locked-day message.

---

### User Story 6 - Sell from the phone offline (Priority: Must, P1)

An admin or accountant creates a sale invoice in steps: pick customer → add lines (fabric → colour → roll, kilograms, pieces including 0, price, fixed line discount) → review (fixed header discount, tax, shipping, optional payment, exchange rate) → save. They can view and cancel invoices.

**Why this priority**: sales are the main business event; this story also proves claims and numbering work with more than 5 phones.

**Independent Test**: on two phones in airplane mode, sell the same roll; reconnect phone A then phone B; confirm A's invoice is kept, B's is cancelled locally with an Arabic alert naming the invoice and roll, and the hub, both phones and a desktop agree on stock and balances.

**Acceptance Scenarios**:

1. **Given** a 3-line invoice with a 10 USD line discount and a 25 USD header discount, **When** it is saved, **Then** each line value is quantity × price − line discount (never below 0), the total is subtotal − discount + tax + shipping, and every figure equals the desktop's for the same inputs.
2. **Given** the user enters an exchange rate of 14,500, **When** the invoice is saved, **Then** that rate is stored on the invoice and never changes later.
3. **Given** the invoice is saved offline, **When** the done screen opens, **Then** it offers Share PDF, Send to customer and New invoice.
4. **Given** two phones sold the same roll offline, **When** both sync, **Then** the first to reach the hub keeps its invoice and the second phone cancels its invoice locally and shows an alert and a notification naming the invoice number and the roll.
5. **Given** an invoice, **When** the user cancels it, **Then** reversal entries are written, the original entries remain, and stock and balances return to their prior values.
6. **Given** a roll with 0 remaining kilograms, **When** the user tries to add it, **Then** it cannot be selected.

---

### User Story 7 - Record a purchase (entry) invoice (Priority: Must, P2)

An admin or accountant records a purchase from a supplier. New colours and rolls needed by the invoice are created in the same save as the invoice, so a failed save leaves no stray colours or rolls.

**Why this priority**: required for stock to be correct when purchases are booked away from the desktop; second after cash and sales.

**Independent Test**: create an entry invoice with 2 new colours and 5 new rolls, kill the app during save, reopen, and confirm neither the invoice nor any of the colours or rolls exist; repeat without killing and confirm all exist.

**Acceptance Scenarios**:

1. **Given** an entry invoice that introduces a new colour, **When** the save fails at any point, **Then** no colour, roll, ledger entry or stock movement from it exists.
2. **Given** a saved entry invoice, **When** it syncs, **Then** the desktop shows the same supplier balance, rolls and stock movements.
3. **Given** an entry invoice, **When** it is cancelled, **Then** reversal entries are written and its rolls' stock is reversed by the same rule as the desktop.

---

### User Story 8 - Record returns (Priority: Must, P2)

An admin or accountant records a sale return or an entry return by picking the source invoice and its lines. Weight-only returns (0 pieces) are allowed. Valuation follows the desktop rule.

**Why this priority**: returns change balances and stock; without them phone users must go back to the desktop for a common event.

**Independent Test**: return 2 lines of a synced sale invoice offline, sync, and compare return value, customer balance and roll stock with the desktop.

**Acceptance Scenarios**:

1. **Given** a sale invoice at rate 14,500, **When** a line is returned, **Then** its value uses the unweighted average price per kilogram of the roll, no discounts, at rate 14,500.
2. **Given** a line with 0 pieces and 12.5 kg, **When** it is returned, **Then** the return is accepted.
3. **Given** a return, **When** it is cancelled, **Then** reversal entries are written and the balance returns to its prior value.

---

### User Story 9 - Check and use the cashbox (Priority: Must, P2)

The user sees cashbox state, movements per day, the balance at a chosen date, and adds manual movements. Admin and accountant can close a day (Should).

**Why this priority**: the owner checks cash daily; manual movements are frequent.

**Independent Test**: add a manual movement offline dated yesterday, then confirm yesterday's and today's balances on the phone equal the desktop's after sync.

**Acceptance Scenarios**:

1. **Given** a manual movement dated yesterday, **When** it is saved, **Then** yesterday's closing balance and every later day's balance move by its amount.
2. **Given** a closed financial year, **When** a user tries to add a movement dated in that year, **Then** it is refused with the desktop's closed-year message.
3. **Given** an accountant closing today in USD with a counted amount, **When** they confirm, **Then** only date, counted amount and currency are sent, and the expected amount is derived from the ledger (Should).

---

### User Story 10 - Look up stock, adjust a roll, count stock (Priority: Must, P2)

Any role browses fabrics → colours → rolls with remaining kilograms and a low-stock badge, and sees a roll's movement history. Allowed roles adjust a roll and enter a stock count on the phone. A roll's price is editable only before its first sale.

**Why this priority**: the warehouse persona's main use; stock counting on a phone walking the shelves is faster than at the desktop.

**Independent Test**: enter a count for 20 rolls on the phone, post it, sync, and compare each roll's remaining kilograms and adjustment movement on the desktop.

**Acceptance Scenarios**:

1. **Given** a fabric with minimum stock 50 kg and 32 kg remaining, **When** the inventory list opens, **Then** that fabric shows a low-stock badge.
2. **Given** a roll that has been sold once, **When** a user opens its price, **Then** the price cannot be edited and the reason is shown.
3. **Given** a count of 18.0 kg for a roll recorded at 20.0 kg, **When** the count is posted, **Then** an adjustment movement of −2.0 kg is recorded, matching the desktop count flow.
4. **Given** an adjustment that would make remaining kilograms negative, **When** it is saved, **Then** it is refused.

---

### User Story 11 - Handle customer orders (Priority: Must, P3)

Admin and accountant create, view, cancel and fulfil orders; pending order conflicts are shown read-only.

**Why this priority**: orders exist on the desktop and are part of parity, but are less frequent than invoices.

**Independent Test**: create an order offline, fulfil it, sync, and compare order state on the desktop.

**Acceptance Scenarios**:

1. **Given** an open order, **When** it is fulfilled, **Then** its state matches what the desktop shows after sync.
2. **Given** a pending order conflict from sync, **When** the user opens it, **Then** it is shown read-only with the message that it must be resolved on the desktop.

---

### User Story 12 - Read reports and profit (Priority: Must, P3)

The user opens summary, party balances, detail reports and profit summary and details for a date range, offline.

**Why this priority**: reading reports away from the desk is valuable but not daily-critical.

**Independent Test**: for a fixed date range, compare every report figure on the phone with the desktop on the same data.

**Acceptance Scenarios**:

1. **Given** a date range, **When** the profit summary opens, **Then** revenue is subtotal minus discount (no tax, no shipping) and cost uses the cost snapshot taken at sale, equal to the desktop's.
2. **Given** USD and SYP documents in the range, **When** a report opens, **Then** figures are shown per currency and never summed across currencies.

---

### User Story 13 - Share a PDF and send it to the customer on WhatsApp (Priority: Must, P2)

From an invoice, return, voucher or statement, the user shares a PDF with the same layout as the desktop print, or presses "Send to customer", edits a note, and WhatsApp opens on that customer's chat with the PDF and note ready; the user presses Send.

**Why this priority**: owner-requested feature that replaces printing for most customers.

**Independent Test**: on a phone with WhatsApp installed, send a statement for a customer with a saved number and confirm the chat that opens is that number's, with the PDF and the note.

**Acceptance Scenarios**:

1. **Given** a saved invoice, **When** the user taps Share PDF, **Then** the Android share sheet opens with a PDF whose Arabic text, amounts and currencies match the desktop print.
2. **Given** a customer with a saved phone number, **When** the user taps Send to customer and enters a note, **Then** WhatsApp opens on that customer's chat with the PDF attached and the note as text, and nothing is sent until the user presses Send.
3. **Given** a customer with no phone number, **When** the user taps Send to customer, **Then** the app asks for a number and offers to save it to the party.
4. **Given** WhatsApp is not installed, **When** the user taps Send to customer, **Then** the share sheet opens with the PDF instead.

---

### User Story 14 - Know the sync state and keep the app up to date (Priority: Must, P1)

The user always sees whether data is synced. A sync status screen lists pending count, last run, last error and rejected or dead documents with "يجب الحل من الديسكتوب" (must be resolved on the desktop). Local notifications report a rejected document, a stopped sync and low stock. If the phone's version differs from the hub's, sync stops and the app asks for an update from Google Play or the direct download.

**Why this priority**: sync failures are invisible without it, and a version mismatch would break money parity.

**Independent Test**: on a test hub, force a rejected unit, a dead unit and a version mismatch, and confirm the status screen, notifications and update banner for each.

**Acceptance Scenarios**:

1. **Given** a document rejected by the hub, **When** the next sync finishes, **Then** a local notification names the document, and the status screen shows the reason with the desktop-resolution message and no requeue button.
2. **Given** the hub runs a newer money/rounding version than the phone, **When** the phone syncs, **Then** sync is refused, a banner "تحديث مطلوب" with a download action appears, and local work continues.
3. **Given** the phone was offline for 21 days with 300 pending units, **When** it reconnects, **Then** units drain in batches of 50 with visible progress and no duplicate appears on the hub.
4. **Given** the hub was moved and its identity changed, **When** the phone syncs, **Then** it rebases automatically, as the desktop does.

---

### User Story 15 - Lock out a lost phone (Priority: Must, P2)

An admin revokes a lost phone from the desktop. When the phone next contacts the hub, it deletes all company data, keys and cached files and returns to the enrollment screen.

**Why this priority**: the phone holds the full company ledger; loss must not leak it.

**Independent Test**: revoke an enrolled test phone from the desktop, bring the phone online, and confirm its data folder holds no company data and the enrollment screen shows.

**Acceptance Scenarios**:

1. **Given** a revoked phone, **When** it next contacts the hub, **Then** it wipes its database, keys and cached PDFs and shows the enrollment screen.
2. **Given** the phone's storage is read directly while the app is closed, **When** the database file is inspected, **Then** its content is not readable without the key.
3. **Given** a non-admin user (including the accountant), **When** they open the device list, **Then** the revoke action is not available.

---

### User Story 16 - Should-have additions (Priority: Should)

Party opening balances (admin/accountant), cashbox day close, the enrollment code shown as a QR on the desktop, and the phone's unsynced count shown on the desktop revoke screen.

**Why this priority**: useful, not needed for the first release; ship if milestones M3/M4 are on time.

**Independent Test**: each item is tested on its own, as listed in its scenario.

**Acceptance Scenarios**:

1. **Given** an accountant sets a supplier opening balance of −1,000 USD, **When** it syncs, **Then** the desktop statement starts from the same opening balance with the same sign.
2. **Given** the desktop's enrollment screen, **When** an admin creates a code, **Then** it is shown both as text and as a QR that the phone can scan.
3. **Given** a phone with 12 unsynced units, **When** an admin opens Revoke for it on the desktop, **Then** the screen states "12 unsynced units will be lost" before confirmation.

---

### User Story 17 - Could-have additions (Priority: Could)

A home-screen widget showing today's cash, saved WhatsApp note templates, and two-pane layouts on tablets.

**Why this priority**: convenience only.

**Independent Test**: each item is tested on its own, as listed in its scenario.

**Acceptance Scenarios**:

1. **Given** the widget is placed, **When** cash changes after a receipt, **Then** the widget shows the new per-currency figures within 15 minutes.
2. **Given** a saved note template, **When** the user taps Send to customer, **Then** they can insert the template into the note.
3. **Given** a device 600 dp wide or more, **When** the parties screen opens, **Then** the list and the selected party's detail show side by side.

### Edge Cases

PRD IDs E1–E18, unchanged:

- **E1** — Two devices sell the same roll offline: the first to reach the hub wins; the loser's document is cancelled locally with an Arabic alert and a notification (FR-34).
- **E2** — A phone uses up its number block while offline: it switches to the existing fallback numbering, reports used numbers to the hub, and no number overlaps another device's.
- **E3** — A phone is offline for weeks: it keeps working, the session lasts one year, and on reconnect the backlog drains in batches of 50 with progress.
- **E4** — The hub's identity changes (hub migrated): the phone rebases automatically (FR-36).
- **E5** — A document is marked dead after 5 failed attempts: it shows in sync status with "resolve on desktop"; there is no requeue action.
- **E6** — The app is killed in the middle of a save: nothing is half-written, and pending sync units stay consistent.
- **E7** — A phone is revoked while it holds unsynced data: the wipe proceeds (lost-device policy); the desktop shows the unsynced count before revoke (Should).
- **E8** — Re-install or a new phone: it re-enrolls with a new sync identity and downloads the company again. Unsynced data of an uninstalled app is lost, so the app warns whenever pending units exist and the user opens logout or the device's app settings.
- **E9** — The phone's version doesn't match the hub's: sync is refused until the update; local work continues.
- **E10** — A day is locked or a year closed on the desktop and pulled to the phone: writes dated in it are refused with the desktop's message.
- **E11** — A payment leaves cash negative: it is allowed, with a warning.
- **E12** — A party name is a duplicate: it is refused with the desktop's message, and the "name — city" convention is suggested.
- **E13** — The party has no phone number for WhatsApp: the app prompts for a number and offers to save it.
- **E14** — WhatsApp isn't installed, or the chat-attach route is unavailable: the app falls back to opening the chat by link plus the share sheet for the file, or the share sheet only.
- **E15** — Free storage is too low for the first download: before starting, the app compares the estimated size with free space and refuses with a message stating both numbers. Cached PDFs are deleted first when space runs low later.
- **E16** — The phone's clock is wrong: documents use the system transaction clock, and a warning shows when the phone's time differs from the hub's by more than 5 minutes.
- **E17** — Writes made on the hub web UI: they don't reach devices (a known gap shared with the desktop). The spec documents it and v1 does not change it.
- **E18** — A user's role is changed while their phone is offline: the new role applies on the next pull, and offline writes already made are judged by the hub when it applies them.

## Requirements _(mandatory)_

### Functional Requirements

Launch, session and lock

- **FR-01**: The app MUST show an animated company-logo splash for at most 1.5 seconds, covering database opening and migration.
- **FR-02**: On an enrolled device, sign-in MUST offer the PIN picker listing the device's users. Password sign-in is the fallback.
- **FR-03**: The session MUST last one year with no idle logout. It MUST end only on logout, a refused session refresh, revocation or a wipe. A "forbidden" answer to any other request MUST NOT end the session.
- **FR-04**: The app MUST hide its content and require fingerprint unlock (PIN fallback) on cold start and after 60 seconds or more in the background. This lock MUST be separate from the session.
- **FR-05**: A user who signed in online once on the phone MUST be able to sign in offline with their PIN. The PIN check uses the same password-hashing parameters as the desktop's local check, Offline rights MUST equal the desktop's: admin and accountant can write; warehouse and viewer are read-only. The accountant MUST hold every admin privilege except granting the admin role, editing an admin account, and revoking devices.

Enrollment and first download

- **FR-06**: The phone MUST join a company only with an enrollment code issued by an admin from the desktop, entered by QR scan or typed. The resulting device credential MUST be stored only in the phone's hardware-backed secure storage.
- **FR-07**: After enrollment the phone MUST download the full company data and catch up to the latest change, showing a percentage and a document count. The download MUST resume after interruption.
- **FR-08**: The company is fixed at enrollment and never changes on that device. A re-install MUST re-enroll with a new sync identity.

Home

- **FR-09**: Home MUST show a cashbox balance per currency (USD and SYP never combined), today's sales, total receivables and payables, the pending sync count and the last successful sync time.
- **FR-10**: Home MUST offer quick actions filtered by role: new sale invoice, receipt, payment, expense, and find party.

Parties

- **FR-11**: Party search MUST work offline with the desktop's matching rules, ordered by most recent use.
- **FR-12**: Party detail MUST show the balance per currency, contact details (the phone number is used by FR-30), recent documents and the statement.
- **FR-13**: The statement MUST use the desktop order (date, creation time, document rank, id) and the desktop running balance. It loads in pages of 200 and continues to the last row.
- **FR-14**: Admin and accountant MUST be able to create and edit parties. A duplicate name in the company MUST be refused with the desktop's Arabic message.

Sales, purchases and returns

- **FR-15**: A sale invoice MUST follow the steps customer → lines (fabric, colour, roll, kilograms, pieces including 0, price, fixed line discount) → review (fixed header discount, tax, shipping, optional payment) → save. The total MUST be computed by the shared business rule, never by the screen. Saving MUST be one step that writes the number, header, lines, ledger, voucher, cashbox and stock together.
- **FR-16**: An entry invoice MUST create any new colours and rolls within the same save as the invoice.
- **FR-17**: Cancelling any document MUST write reversal entries and MUST NOT edit or delete earlier entries.
- **FR-18**: Sale and entry returns MUST use the source invoice's lines, value them at the unweighted average roll price per kilogram with no discounts at the invoice's frozen rate, and accept 0 pieces.
- **FR-19**: The user MUST enter the exchange rate as SYP per 1 USD. When online, the app MUST pre-fill the hub's reference rate and keep it for offline use. The rate MUST be frozen on the document.

Vouchers, expenses and cashbox

- **FR-20**: A receipt or payment MUST record the party, the amount actually moved, currency, rate, an optional write-off added to the settlement, and optional invoice settlement. A resulting negative cash balance MUST be allowed, with a warning.
- **FR-21**: Amending a voucher MUST be a single replace operation (cancel and create together), never two separate operations.
- **FR-22**: Expenses MUST support name autocomplete from earlier expense names, amount, currency, and cancel.
- **FR-23**: The cashbox MUST show its state, movements by day, the balance at a date, and manual movements. Writes dated on a locked day or in a closed year MUST be refused with the desktop's messages.

Inventory and orders

- **FR-24**: Users MUST be able to browse and search fabrics, colours and rolls with remaining kilograms. A low-stock badge shows when remaining kilograms fall below the fabric's minimum stock.
- **FR-25**: Roll detail MUST show its movements. Allowed roles can adjust a roll. The price is editable only before the roll's first sale.
- **FR-26**: A stock count MUST be entered per roll on the phone and posted as adjustment movements, following the desktop count flow. Admin and accountant MUST be able to record and post counts offline; warehouse and viewer MUST NOT record counts while offline.
- **FR-27**: Admin and accountant MUST be able to create, view, cancel and fulfil orders. Pending order conflicts are shown read-only.

Reports

- **FR-28**: Summary, party balances, detail reports, and profit summary and details MUST be available offline, read-only and filtered by date range. Profit uses the cost snapshot taken at sale.

Sharing

- **FR-29**: Invoices, returns, vouchers and statements MUST be shareable as a PDF with the same layout as the desktop print, with the Arabic font embedded, through the Android share sheet.
- **FR-30**: "Send to customer" MUST use the party's saved number (or one entered on the spot) and an editable note, and open WhatsApp on that chat with the PDF and the note. When attaching to that chat is not possible, it MUST fall back to opening the chat by link with the note, followed by the share sheet for the PDF. Nothing is sent without the user pressing Send.

Sync

- **FR-31**: Every write MUST queue its sync units through the same path the desktop uses, each with a durable operation id.
- **FR-32**: Sync MUST run on app start, on return to the foreground, when the network returns, after each write (debounced), and every 20 seconds while in the foreground. It retries after 30 seconds and 2 minutes, drains in batches of 50, and runs in the background at least every 15 minutes (best effort, as Android allows).
- **FR-33**: Units MUST be sent in the desktop's push lanes: lane 0 for masters, orders, ledger, settlements, cashbox, settings and company, in recorded order; lanes 1–3 for invoices, returns, vouchers and expenses, grouped by document.
- **FR-34**: When two devices claim the same resource, the first to reach the hub wins. The losing phone MUST cancel its document locally and show an Arabic alert and a notification naming the document and the roll.
- **FR-35**: Phones MUST reserve smaller number blocks than desktops so that more than 5 phones per company don't exhaust numbering. When a block runs out offline, the phone uses the fallback numbering and reports the used numbers. Phone block sizes MUST be 100 for invoices and 50 for every other document type.
- **FR-36**: When the hub's identity changes, the phone MUST rebase as the desktop does (reset its position, re-send delivered history, re-report numbering tips).
- **FR-37**: A read-only sync status screen MUST show the pending count, last run, last error and rejected or dead documents with "يجب الحل من الديسكتوب". It MUST NOT offer requeue.
- **FR-38**: The phone MUST send its app version, and sync MUST be refused when its money/rounding or schema version differs from the hub's. The phone then shows "تحديث مطلوب" with a download action. The hub does not enforce this today (verified 2026-10-25), so it is delivered by backend change BC-2; milestone M0 re-confirms before BC-2 work starts.

Security

- **FR-39**: Company data on the phone MUST be encrypted at rest. The key is kept only in the phone's hardware-backed secure storage.
- **FR-40**: When an admin revokes the phone from the desktop and the phone learns of it on its next hub contact, the phone MUST delete its database, keys and cached files and show the enrollment screen.
- **FR-41**: Screenshots are allowed. App content MUST be hidden in the Android recent-apps view.

Updates and distribution

- **FR-42**: The app MUST be distributed on Google Play and as a direct APK download, both signed with the same owner-held key, so a user can switch channels without uninstalling.
- **FR-43**: The direct-APK build MUST check a version manifest published by the hub and offer the download when a newer version exists. Sync stays refused until updating when FR-38 applies.

### Non-Functional Requirements

- **NFR-01**: Cold start to an unlocked home screen MUST take 2.5 seconds or less on a mid-range Android phone (4 GB RAM, Android 10 or later) holding 100,000 documents.
- **NFR-02**: Party search MUST take 150 ms or less, the first statement page 500 ms or less, and an invoice save 300 ms or less, all measured on the same reference phone.
- **NFR-03**: The phone MUST hold the full company data and be proven at 10,000, 50,000 and 100,000 documents.
- **NFR-04**: Every Must flow except enrollment and the first download MUST work with no network for any length of time.
- **NFR-05**: Money MUST follow the desktop: rounding half away from zero to 2 or 4 decimal places only through the shared rounding rule, stored as exact scaled whole numbers, with results identical to the hub's.
- **NFR-06**: Each document MUST be saved in one durable step. Pending sync units MUST survive the app being killed, the OS killing it, and an app update.
- **NFR-07**: The app MUST support Android 8.0 (API 26) and later, with performance targets set for Android 10 and later. It MUST be usable on phones from 360 dp to 480 dp wide, and on tablets.
- **NFR-08**: The installable package MUST be 60 MB or smaller.
- **NFR-09**: Touch targets MUST be at least 48 dp and body text at least 16 sp, contrast MUST meet WCAG AA, and layouts MUST hold at 130% system font scale without clipped text.
- **NFR-10**: The interface MUST be Arabic only and fully right-to-left, with Western Arabic digits (as on the desktop) and the currency shown on every amount.
- **NFR-11**: At least 99.5% of sessions MUST be crash-free during the pilot.
- **NFR-12**: v1 MUST NOT include analytics or crash-reporting services.
- **NFR-13**: Background sync MUST use 2% or less of the battery per day at pilot usage levels.

### Phone-first presentation rules (constitution Principle VIII)

- **UX-01**: Each screen serves one task. Long flows are split into steps (party → lines → review). Lists show cards, not wide tables, and there is no horizontal page scroll from 360 dp to 480 dp.
- **UX-02**: The primary action sits at the bottom of the screen and stays visible when the keyboard is open.
- **UX-03**: A sync chip (synced / pending N / offline / attention) is visible on every screen.
- **UX-04**: Navigation is a bottom bar in right-to-left order: Home, Customers & suppliers, Add (sale, purchase, receipt, payment, expense, return, order), Inventory, More (reports, cashbox, orders, sync status, profile and logout). Items are filtered by role.
- **UX-05**: A negative balance shows both a minus sign and the negative colour.
- **UX-06**: Brand identity (logo, colours, font) matches the desktop, with larger spacing and fewer elements per screen.
- **UX-07**: Successful actions confirm with a success message; failures with an error message. The two are never swapped.
- **UX-08**: Amounts and kilograms use a numeric keypad with thousands separators while typing. Party, fabric, colour and roll are picked from searchable bottom sheets.

### Out of Scope (Won't have in v1)

- iOS release (the product must stay buildable for iOS later; nothing is shipped or tested on iOS in v1).
- Barcode or QR scanning of rolls. QR is used only for enrollment.
- Push notifications sent from a server.
- LAN or direct desktop-to-phone sync.
- WhatsApp Business API or automatic sending.
- English interface.
- On the phone: system settings (backup, Google Drive, printing, units, warehouses, invoice settings, users, payment methods, company profile edit).
- On the phone: year closing and the ledger screen.
- On the phone: print center and press (print-send and print-receive) invoices.
- On the phone: the sync conflict resolution screen and the activity log.
- Backup and restore, Smart Merge, Phenix import, licence administration, party merge and dye purge.
- Any change to an owner accounting decision still open in the project brain "Open Issues". The phone behaves exactly as desktop 3.0.7 does.
- Dark theme (deferred until after v1).
- Fixing the hub web-UI pull gap (E17) and freezing historical party/fabric names.

### Key Entities

- **Company (tenant)**: the business whose data the phone holds. Exactly one per device, fixed at enrollment.
- **Device**: an enrolled phone with its own sync identity, credential, number blocks and revoked state.
- **User**: a person with one role (admin, accountant, warehouse, viewer) and a PIN. Users are listed per device.
- **Party**: a customer or supplier, with a name unique in the company, a phone number, an opening balance and a balance per currency.
- **Fabric → Colour → Roll**: a fabric has a minimum stock level; a colour belongs to a fabric; a roll belongs to a colour and has remaining kilograms (never below 0), a price per kilogram, an optional supplier and a source (purchase, press or stock-in).
- **Invoice (sale or entry)** with **invoice lines**: each line refers to one roll and stores the cost per kilogram at sale. The header holds the frozen exchange rate, discounts, tax, shipping and status (active or cancelled).
- **Return** with **return lines**: refers to a source invoice.
- **Voucher (receipt or payment)**: party, amount moved, currency, rate, write-off, and settled invoices.
- **Expense**: name, amount and currency.
- **Order** with **order items**: a customer order with open, fulfilled or cancelled state.
- **Ledger entry**: append-only, double-entry, one of the desktop's entry types, with a frozen rate.
- **Cashbox day**: the per-currency daily balance derived from the ledger and manual movements, with a locked state.
- **Stock movement**: every change to a roll's kilograms (initial, sale, return, adjustment, count).
- **Sync unit**: a queued change with a durable operation id, a lane and a status (pending, delivered, rejected, dead).
- **Number block**: a range of document numbers reserved by one device.

### Dependencies (backend changes, PRD §11.3)

- **BC-1**: device-side block size per device kind (phone: invoice 100, every other document type 50).
- **BC-2**: version gate on push and pull; required, because no app-version check exists in the hub's sync today (verified 2026-10-25, re-confirmed in M0).
- **BC-3**: a distinct, machine-readable "revoked" reason in hub refusals, so the phone can wipe (verify the existing refusal first).
- **BC-4**: the desktop shows the enrollment code as a QR (Should).
- **BC-5**: a version manifest published by the hub for the direct-APK channel (FR-43).
- **BC-6**: shared business code moved into a package both the desktop and the phone use, deferred until after the pilot. In v1 the phone imports the desktop's business and sync code in place from `backend/`, behind an import boundary that bans server-only modules; no desktop file is moved.

Each backend change MUST keep the desktop's full test suites on both database engines passing (constitution Principle V).

## Success Criteria _(mandatory)_

### Goals (PRD G1–G5)

- **G1**: Daily shop work is done from a phone with no connection: 100% of Must write flows pass in airplane mode.
- **G2**: The phone, desktop and hub never differ in accounting: 0 mismatches on the shared money cases and on the sync comparison suite.
- **G3**: The phone is faster than walking to the desktop: median time to record a receipt is 20 seconds or less, and a 3-line sale invoice is 60 seconds or less.
- **G4**: The app is clear on any phone size: usable from 360 dp to 480 dp and on tablets, with no horizontal scroll and touch targets of at least 48 dp.
- **G5**: A lost phone is safe: an admin revokes it, its data is wiped on its next contact, and data at rest is unreadable without the key.

### Measurable Outcomes

- **SC-001**: 0 differences across the shared money cases plus 1,000 random documents replayed on phone, desktop and hub.
- **SC-002**: At least 99.9% of sync units are delivered without manual action during a 30-day pilot, with 0 duplicates.
- **SC-003**: 100% of Must write flows pass the airplane-mode device test.
- **SC-004**: Median time to record a receipt is 20 seconds or less, and a 3-line sale is 60 seconds or less, measured during the pilot.
- **SC-005**: Cold start takes 2.5 seconds or less with 100,000 documents on the reference phone.
- **SC-006**: At least 99.5% of pilot sessions are crash-free.
- **SC-007**: At least 60% of receipts and payments at the pilot shop are recorded from phones within 60 days of rollout.
- **SC-008**: 1 or fewer sync-related support issues per shop per month after the first 30 days.

## Assumptions

- The pilot shop runs at least 5 phones for 30 days (milestone M5), with the hub and every desktop updated to the same version as the phones.
- The reference phone for performance targets is a mid-range Android device with 4 GB RAM running Android 10 or later.
- The owner provides the app signing key and a Google Play developer account registered in a country Play allows. Without the Play account, only the direct APK ships, and FR-42 is met for that channel alone.
- The desktop print layouts are the source for the PDF layouts.
- Existing desktop Arabic messages are reused where they are correct. New messages are written in the same style.
- The highest-risk checks (milestone M0) come first: the local database supports the desktop's exact decimal calculations and encryption on the phone; the desktop's business rules run on the phone; and PDFs render with an Arabic font. Planning begins only once each passes or its fallback is chosen.
- The dark theme is deferred until after v1; v1 ships the light theme only.
