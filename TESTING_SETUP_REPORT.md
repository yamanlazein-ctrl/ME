# Testing Setup Report — Vitest · TesterArmy e2e · Sentry

**Date:** 2026-10-11 · **Project:** `C:\Users\Taw\Downloads\Compressed\q\ME-main` · **HEAD:** `729fcd98` (nothing committed, pushed or deployed; all existing uncommitted work preserved).
**Environment:** Windows 11, Node 24.18.0, npm 11.16. RAM was the constraint (0.4–0.6 GB free early; 2.8 GB free once other apps released memory). Suites were run **one at a time**; no process of the owner's was stopped.

## Summary

| Tool           | Installed / configured                                                                  | Real execution                                                                                                               | Verdict                                                                        |
| -------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Vitest         | Yes (existing, frontend + backend)                                                      | Backend SQLite **916 passed / 0 failed / 40 skipped**; frontend **356 / 356**                                                | **PASS**                                                                       |
| TesterArmy e2e | Yes (`e2e` 0.19.0, `@e2e-dev/web` 0.14.0, Chromium headless shell 153)                  | **4 / 4 browser tests passed** in real Chromium against an isolated stack; found 1 real defect (fixed) and 2 more (reported) | **PASS** (deterministic steps) · AI steps **BLOCKED** (no provider authorized) |
| Sentry         | Plugin 1.4.0 enabled; app SDKs configured (backend + web frontend) with privacy filters | Unit tests of the configuration pass; **no event sent anywhere**                                                             | **BLOCKED** for cloud verification (not signed in, no DSN)                     |

---

## 1. Vitest — business logic

**Configuration:** reused as found. Root `vitest.config.ts` (frontend `src/**` + `packages/shared/**`), `backend/vitest.config.ts` (backend; SQLite or PostgreSQL by `DB_ENGINE`). Scripts: `npm test` (root), `npm test` / `npm run test:sqlite` (backend).

**Coverage check first (not assumed):** the critical money paths already have real-database tests that run on SQLite (the engine customers' desktops use). Executed to prove it:

```
cd backend && DB_ENGINE=sqlite npx vitest run tests/customer-statement-reconcile.test.ts tests/cross-currency-settlement.test.ts \
  tests/settle-invoices-persistence.test.ts tests/customer-credit-advance.test.ts tests/live-roll-stock-balance.test.ts \
  tests/voucher-exact-invoice-closure.test.ts tests/settlement-discount-equations.test.ts tests/cashbox-balance-guard.test.ts \
  tests/invoice-ledger-legs-balance.test.ts tests/statement-payment-document.test.ts tests/sqlite/roll-adjustment.test.ts
→ 11 files, 47 tests passed, 0 skipped
```

They cover invoice totals, partial payments, customer balances/statements, USD/SYP separation and cross-currency settlement, cashbox per currency, ledger balance, returns, and stock counts/adjustments. Duplicating them would add nothing.

**Added (the two gaps the forensic audit's adequacy matrix lists):** `backend/tests/money-chain-integrity.test.ts` (engine-agnostic, real repositories):

1. **Concurrent partial receipts on one invoice** — five receipts submitted together (10 + 15 + 5 + 20 + 12.5): invoice `paid` = 62.5 exactly, remaining 37.5 = party ledger = statement, cashbox +62.5. A lost update would keep one receipt.
2. **One sale on a real DB** — persisted ledger legs balance in base currency, the roll loses exactly the sold kg (50 → 42.5), and a cancel restores the stock and the party ledger.

`DB_ENGINE=sqlite npx vitest run tests/money-chain-integrity.test.ts` → **2 passed**.

**Full runs (sequential):**

| Command                                                        | Result                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `cd backend && DB_ENGINE=sqlite npx vitest run --maxWorkers=2` | **157 files passed, 8 skipped; 916 tests passed, 40 skipped, 0 failed** (baseline before this task 914) |
| `npx vitest run --maxWorkers=2` (root)                         | **80 files, 356 / 356 passed** (incl. 3 new Sentry tests)                                               |
| `cd backend && npx vitest run tests/sentry-scrub.test.ts`      | **2 passed**                                                                                            |

Skipped tests are PostgreSQL-only by design. **Not run in this task:** the full backend suite on PostgreSQL (memory — see "not tested").

**Defects found by Vitest:** none in business logic (old or new). The 916/0 result has no failures to separate into old vs new.

---

## 2. TesterArmy e2e — real browser journeys

**Installation:** `npm install --save-dev e2e@0.19.0 @e2e-dev/web@0.14.0` in the project (Node 24.18 meets `^22.22.3 || >=24.8.0`). Chromium headless shell 153 downloaded on first run. Production audit still 0 vulnerabilities.

- **Config:** `e2e.config.ts` — no `agents` block (no AI model, no cost). The target starts `tests/e2e/cert-stack.mjs`, which recreates a **disposable `erp_cert` PostgreSQL database**, seeds one tenant + admin, and serves backend `:18080` + UI `:18081`. The owner's data and the other agent's servers on `:8080/:8081` were never touched. `reuseExisting: true` lets local runs attach to one already-started stack (CI ignores it).
- **Script:** `npm run test:agentic` (`test:e2e` was already the existing Playwright suite).
- **`.gitignore`:** `.e2e/` added.
- **MCP:** registered for this project in `.mcp.json` (`npx e2e mcp`) — **awaiting the owner's approval** at the next Claude Code start.
- **Skill:** reused from the user-level install (`~/.agents/skills/e2e`, linked into `~/.claude/skills/e2e`).
- **`npx e2e init` was not used:** `--yes` turns on the paid Vercel AI Gateway, and the interactive wizard needs a terminal. The official manual route was followed instead.
- **Telemetry:** off for every run (`E2E_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`).

**Environment for the runs:** throwaway PostgreSQL 17.10 from `desktop/retired-postgres/resources-postgres/bin`, data dir in the session scratchpad, port **56437** (ports 55372–55471 are a Windows excluded range). Admin password = a random throwaway value for the disposable database, never written in code. RAM checked before starting (2.8 GB free); one stack at a time; the stack and database were stopped afterwards.

**Tests (all deterministic `screen` / `expect` steps + server-side checks):**

| File                                   | Journey                                                                                                                                                                                                                                                                                                                                                                                             | Result                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `tests/agentic/expenses-paging.e2e.ts` | sign in → dashboard                                                                                                                                                                                                                                                                                                                                                                                 | **PASS**                       |
|                                        | 21 expenses → the list shows the server total and pages to the rest (FE-03 fix)                                                                                                                                                                                                                                                                                                                     | **PASS**                       |
| `tests/agentic/sales-journey.e2e.ts`   | create customer in the UI → sale invoice USD 10 kg × $10 with $40 cash (the app asks to book the **$60** rest as debt — asserted) → server holds total 100 / paid 40 → receipt $25 linked to the invoice (the form offers it with **$60** remaining — asserted) → server paid 65 → statement API final balance **35** → statement screen shows **“35 مدين”** and **“المسحوبات 100 · المقبوضات 65”** | **PASS**                       |
| `tests/agentic/inventory-count.e2e.ts` | 50 kg roll counted 48 while the search is still applying → count kept → **"عجز 2 كغ"** (2 kg short) → review & post → server roll = **48 kg**                                                                                                                                                                                                                                                       | **PASS** (after the fix below) |

```
npm run test:agentic → Test Files 3 passed (3) · Tests 4 passed (4) · 19.3 s
```

### Defects found by e2e

**E2E-1 [P2] A count typed while the search is applying is silently lost — CONFIRMED, FIXED.**

- **Symptom:** the operator types the shelf weight into a row; the row snaps back to "غير معدود" (not counted) and nothing is saved, with no message.
- **Root cause:** the count sheet's search is debounced 300 ms. When the filter changes, `useInfiniteQuery` starts a new key with no data, so `lines` is empty and the whole table **unmounts** for the fetch. The row being typed in is destroyed, its unsaved value with it. Status filters do the same.
- **Fix:** `src/routes/inventory_.count.tsx` — `placeholderData: keepPreviousData` keeps the current rows mounted while the next filter loads. Rows are keyed by `rollId`, so the typed value survives.
- **Proof (deterministic, waits on the filtered response — no sleeps):** without the fix **2/2 FAIL** (`toHaveValue("48")` fails); with the fix **3/3 PASS**.

**E2E-2 [P3] Statement rows: a receipt paid together with its invoice can be listed before that invoice — CONFIRMED, NOT FIXED (needs owner approval).**

- **Seen live:** row 1 = receipt $40, running balance **−40** (the customer looks in credit); row 2 = the $100 invoice, balance 60. Totals and the final balance are correct.
- **Root cause:** statement order is `date, created_at, id` on both engines. An invoice and its linked receipt are written in one transaction with the same `created_at` (on PostgreSQL, `now()` is fixed for the transaction), so the random UUID decides — a coin flip.
- **Why not fixed now:** the order also drives statement paging (keyset cursor + offset, 4 query sites per engine), which has had duplicate-row bugs before. Changing it **reorders old statements when reprinted**, which is a business decision.
- **Proposed fix:** add a tie-break between `created_at` and `id` that puts the document (invoice/return) before payments; extend the cursor with it; add a test with both orders.

**E2E-3 [P2] Form fields without accessible names — CONFIRMED, NOT FIXED (needs owner approval).**

- On the add-customer dialog every field is an unnamed `textbox` ("اسم العميل *" is plain text, not a `<label for>`); the receipt notes and the invoice totals (e.g. المدفوع "paid") are the same. 0 `htmlFor` / 0 `aria-label` across six journey screens.
- **Impact:** screen readers cannot name the fields, and tests must find them by nearby text. The e2e tests use XPath by label text for these fields.
- **Fix (proposed):** tie the shared `Field` label to its input (`useId` + `htmlFor`) in `PartyFormDialog` and the voucher form, then switch the tests to `getByLabel`. It touches many screens, hence the approval.

### Not used / blocked

- **AI steps (`agent.act`, `agent.assert`): BLOCKED** — need a model provider the owner authorizes (options in the Arabic summary). No AI or paid service was used.
- **e2e MCP live session:** registered, awaiting the owner's approval.
- **External calls during runs:** none by the tests. The app's own header widget fetched the LiraScope exchange rate (built-in product behavior).

---

## 3. Sentry — two different things

### a) Claude Code integration (plugin + MCP)

- Plugin `sentry@claude-plugins-official` 1.4.0: **enabled**. A duplicate hand-added `sentry` MCP server was removed; the plugin's own `plugin:sentry:sentry` is kept.
- **Status: "Needs authentication" → BLOCKED.** No project errors could be read, because the connection is not signed in.

### b) The application's own SDKs

| Part                                                                                      | State                                                                                                                                                    | Privacy                                                                                                                                                                              | Performance                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend (`@sentry/node` 10.70, `server.ts`)                                               | Existing: on when `SENTRY_DSN` is set; Express error handler. **Added:** `sendDefaultPii: false` + `beforeSend: scrubSentryEvent`                        | `backend/src/infrastructure/config/sentryScrub.ts` strips `Authorization`, cookies, setup/runtime tokens, request bodies, query strings and user info from every event. **Test 2/2** | Existing `tracesSampleRate` 0.1 in production (1.0 elsewhere). `profilesSampleRate` is set but no profiling integration is installed, so profiling never runs. |
| Web frontend (`@sentry/react` 10.76.2, `src/lib/sentry.ts`, called from `src/router.tsx`) | **Added:** on only when `VITE_SENTRY_DSN` is set; plugs into the app's existing `reportError` hook (`window.__errorReporter`)                            | Errors only, `sendDefaultPii: false`, no session replay                                                                                                                              | Errors only (no tracing), to keep customer/money screens out of traces                                                                                         |
| Desktop build                                                                             | **Off by design.** Its CSP (`connect-src 'self' ipc:`) blocks any external connection and it is offline-first; enabling it is a CSP and privacy decision | —                                                                                                                                                                                    | —                                                                                                                                                              |

- **Tests:** `src/lib/sentry.test.ts` 3/3 (off without DSN, off on desktop, on + hook wired with DSN); `backend/tests/sentry-scrub.test.ts` 2/2. Web and desktop builds both pass.
- **Cloud delivery: BLOCKED / NOT VERIFIED.** No DSN was available and the MCP is not signed in, so **no event was sent** — not to production, not to development.

---

## 4. Regression after the fixes

| Command                                                      | Result                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `npm run test:agentic`                                       | 4 / 4 passed                                                                                           |
| `npx vitest run --maxWorkers=2`                              | 356 / 356 passed                                                                                       |
| `npx tsc --noEmit` (root and backend)                        | 0 errors                                                                                               |
| `npm run build` (web) and a `VITE_DESKTOP_DEPLOY=true` build | both built                                                                                             |
| `npx eslint` on every file changed in this task              | clean, except 1 pre-existing Prettier error in `inventory_.count.tsx` (also present at HEAD; not mine) |

## 5. Files changed in this task

- `backend/tests/money-chain-integrity.test.ts` (new) — the two money-chain gaps.
- `backend/src/infrastructure/config/sentryScrub.ts` (new), `backend/tests/sentry-scrub.test.ts` (new), `backend/src/presentation/server.ts` (Sentry privacy options).
- `src/routes/inventory_.count.tsx` — E2E-1 fix.
- `tests/agentic/sales-journey.e2e.ts`, `tests/agentic/inventory-count.e2e.ts` (new); `tests/agentic/expenses-paging.e2e.ts` (Idempotency-Key header, `meta.total`).
- `e2e.config.ts` — `reuseExisting: true` for local runs.

(From the previous setup step: `e2e.config.ts`, `.mcp.json`, `.gitignore`, `package.json` dev dependencies + `test:agentic`, `src/lib/sentry.ts` + test, `src/router.tsx`, `src/vite-env.d.ts`, `.env.example`.)

## 6. Not tested, and why

- **Backend suite on PostgreSQL** — not re-run in this task; a full run was killed for low memory earlier today. The e2e runs used PostgreSQL through the real API, but that is not the unit suite.
- **AI-assisted e2e steps** — no authorized model provider.
- **Sentry cloud delivery and reading project errors** — not signed in, no development DSN.
- **Desktop app (Tauri) in a browser test** — e2e drives the web build; the desktop shell, installer and IPC are separate.

## 7. What the owner needs to do

1. **Choose an AI provider** for `agent.*` steps, or keep deterministic-only.
2. **Sign in to Sentry:** `/mcp` → `plugin:sentry:sentry` → browser sign-in.
3. **Create a development Sentry project** and set its DSN yourself as `VITE_SENTRY_DSN` (web build) / `SENTRY_DSN` (backend) — never in chat. Then a development test event can be verified.
4. **Approve the e2e MCP server** at the next Claude Code start.
5. **Decide on E2E-2** (statement order) and **E2E-3** (field labels).

---

## 8. Follow-up: E2E-2 and E2E-3 fixed (2026-10-11, owner-approved)

### E2E-2 — statement order — FIXED (SQLite + PostgreSQL)

- `backend/src/domain/ledger-entry-type.ts`: `STATEMENT_DOCUMENT_TYPES` (sales/purchase invoice, sales/purchase return).
- `PostgresStatementRepository.ts` and `sqlite/SqliteStatementRepository.ts`: order is now `date, created_at, docRank, id` (`docRank` 0 for those documents, 1 otherwise) in **both** ORDER BYs (page window + the "rows before this page" head) and **both** cursor predicates (after-cursor page, ≤-cursor running balance). The cursor row's rank is read from the row by id, so the cursor format (`date|createdAt|id`) and any cursor a client holds are unchanged. Totals and balances are untouched.
- Regression test `backend/tests/statement-document-order.test.ts` (engine-agnostic; 8 sales paid at the counter): every invoice precedes its receipt and balances never go below zero; cursor walk = full window; page-number walk = full window.
  - SQLite: RED before (order test failed) → GREEN 3/3. PostgreSQL (live, port 56437): RED with the HEAD files → GREEN 3/3.
  - All statement-related backend tests: SQLite 11 files / 58 passed; PostgreSQL 11 files / 58 passed.
- Not re-stamped: the SQLite twin's `PORTED-FROM` hash was already stale at HEAD (26 drifting twins before and after); re-stamping would certify unreviewed earlier drift.

### E2E-3 — form labels — FIXED (customer + receipt/voucher forms)

- `src/components/common/FormField.tsx`: the label is tied to its control. A single `Input`/`Textarea` child gets a `useId` id automatically (its own id kept); composite controls pass `htmlFor` and put the id on the focusable element. Two controls never share an id.
- `PartyFormDialog.tsx` (local `Field` delegates to `FormField`; 6 Select triggers get explicit ids), `QuickCustomerDialog.tsx` (3 inputs), `VoucherForm.tsx` (local `Field` delegates; linked-invoice / currency / method Selects + both notes text areas). The party picker button keeps its own visible name; the amount fields already had `aria-label`s.
- Test `src/components/common/FormField.test.tsx`: old `FormField` 4/5 failed → new 5/5 passed.
- e2e `tests/agentic/sales-journey.e2e.ts` now uses `getByLabel` for the customer name and the receipt's linked-invoice and currency fields, and asserts the statement shows the sale before its receipt. The invoice form's "المدفوع" field is outside this change and keeps its XPath locator.

### Results

| Check                                   | Result                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run` (root)                 | 361 / 361                                                                                                                                             |
| `npx tsc --noEmit` root + backend       | 0 errors                                                                                                                                              |
| `npm run build`                         | built                                                                                                                                                 |
| ESLint, changed files                   | no new errors or warnings vs HEAD; repo warnings still 50 (limit 50)                                                                                  |
| e2e re-run with the new label selectors | **NOT RUN — BLOCKED:** 0.3 GB free RAM; the browser stack needs ~1.5 GB. Command when memory allows (database on 56437 first): `npm run test:agentic` |
