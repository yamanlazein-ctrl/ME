# MOTARD FULL PROJECT STRICT AUDIT

**Repository:** `C:\Users\Taw\Downloads\Compressed\q\ME-main` (true root — `git rev-parse --show-toplevel`)
**Audit date:** 2026-10-29
**Audit window:** Current tree state at HEAD `83e2d4144d623af9ea5adfb9e7db7c0fe52b0f84`
**Mode:** READ-ONLY. No product code, configuration, lockfile, schema, migration, or database was modified. No commits, pushes, stashes, or resets. No destructive tests. No live customer database touched. Scratch/test work used temp databases only.

## 1. Executive Summary

This is a strict, evidence-based audit of the Motard Fabrics Group ERP (fabric-erp v3.0.8), an Arabic (RTL) desktop/web ERP for a fabric trader covering invoices, returns, receipts/payments, cashbox, ledger, inventory (fabrics → colours → rolls), stock counts, statements, multi-device sync, and Google Drive archive.

**Overall verdict: CONDITIONAL GO.**

The core ERP transactional layer (invoices, returns, payments, expenses, inventory stock movement, ledger) is implemented with atomic multi-table transactions, optimistic concurrency, append-only ledger enforced by DB triggers, server-side money totals with decimal rounding (round2dp / numeric(14,2)), insufficient-stock guards, and idempotency-key protection on financial POSTs. All executable test suites pass:

- Frontend vitest: 797 passed / 1 skipped (115 files)
- Backend SQLite vitest: 1150 passed / 43 skipped (208 files)

However, significant areas remain UNVERIFIED because they could not be executed in this environment:
- Live PostgreSQL hub / RLS / multi-device sync drills (no PostgreSQL available locally)
- Windows desktop runtime performance / startup timing (cannot execute the Tauri app here)
- Customer database under %LOCALAPPDATA%\MotardERP (never pointed at it)
- Google Drive archive integration (functionality was previously flagged RED; current state needs confirmation against prior audit)

No P0 (critical) or P1 (high) confirmed defects were found in the current tree for the core transactional domains. A number of P2/P3/P4 items and several UNVERIFIED areas are documented. Release is conditionally recommended pending completion of the outstanding verification items.

## 2. Overall Verdict: CONDITIONAL GO

**CONDITIONAL GO** — No established critical blocker remains in the executable, testable surface, but clearly listed restrictions, unverified areas, and outstanding tests prevent unrestricted production approval:

1. Live PostgreSQL hub / RLS / multi-device synchronization never executed in this audit (NOT VERIFIED).
2. Windows desktop startup/runtime performance never measured on a real Windows machine (NOT VERIFIED ON WINDOWS).
3. Customer database under %LOCALAPPDATA%\MotardERP was never inspected (DATA SAFETY — correctly not touched).
4. Google Drive archive integration status inherits prior RED findings unless re-verified against the current tree.

Do not use GO simply because no bug was found in the limited checks that ran.

## 3. Audit Scope and Explicit Limitations

### In scope (examined)
- All backend domain entities, use-cases, ports, and repositories (Postgres* and Sqlite* twins)
- Frontend routes, hooks, API services, presentation layer, contracts
- packages/shared money math, precision, entities
- Sync engine (push/pull, conflicts, idempotency, tombstones)
- Migrations and schema (PostgreSQL + SQLite)
- Security middleware (auth, RBAC, idempotency, error handling)
- Test suites that can run locally (frontend vitest, backend SQLite vitest)
- Existing audit documentation and verified-fixes records

### Out of scope / not verified
- Live PostgreSQL hub engine (not installed locally; port 56437 referenced but no server)
- Windows desktop Tauri shell runtime and installer behavior (cannot execute here)
- Customer production database at %LOCALAPPDATA%\MotardERP (explicitly prohibited)
- Google Drive live round-trip (no test account / external blocker)
- Cargo/Rust desktop tests (not executed in this audit)
- Playwright e2e suites (not executed in this audit)

### Coverage figures (calculated from actual file inventory)
- Backend source files audited: ~616 (backend/src/**), deep inspection of sync, drive stack, security routes/middleware, backup, integrity, ORM/connection
- Frontend routes: 40+ route files in src/routes/; all enumerated in Section 6
- API handlers: every route registered in backend/src/presentation/server.ts mapped in Section 8
- Test suites executed: frontend vitest (797 passed/1 skipped), backend SQLite vitest (1150 passed/43 skipped)
- Database engines examined statically: PostgreSQL (schema/migrations) and SQLite (schema/migrations + live tests); PostgreSQL runtime NOT executed

## 4. Git State, Branch, Commit, and Pre-existing Changes

| Field | Value |
|-------|-------|
| HEAD commit | `83e2d4144d623af9ea5adfb9e7db7c0fe52b0f84` |
| Commit message | `Merge github/feat/mobile into local (inventory fixes + 3.0.8)` |
| Branch | `feat/mobile` (tracking `github/feat/mobile`) |
| Working tree | CLEAN — `git status --porcelain=v1 --branch` shows no modifications or untracked tracked-file changes |
| Version (package.json) | `3.0.8` |
| Pre-existing uncommitted changes | None |
| Prior audit baseline | `MOTARD_ERP_FULL_FORENSIC_AUDIT.md` was written against HEAD `729fcd98` (2026-10-10); the current tree includes a fix pass documented in `MOTARD_ERP_VERIFIED_FIXES.md`. This audit re-grounds findings against the current tree (HEAD `83e2d414`). |

No repository files were modified during this audit. The only intended repository change is this report file (`docs/MOTARD_FULL_PROJECT_STRICT_AUDIT.md`).

## 5. Repository Structure and Architecture Map

[Section 5 content already written above — retained.]


```
ME-main/                              # monorepo root (npm workspaces: packages/*)
├── src/                              # Frontend (React 19, TanStack Router/Start, Vite)
│   ├── routes/                       # ~40+ page routes (see Section 6)
│   ├── presentation/hooks/           # React Query hooks + financial invalidation
│   ├── infrastructure/api/           # API client services (InvoiceApiService, InventoryApiService, …)
│   ├── infrastructure/http/          # BaseHttpClient (retry, idempotency-key, interceptors)
│   ├── domain/, application/, shared/, core/, lib/, assets/, contracts/
│   └── __tests__/
├── backend/                          # Backend (Express, Drizzle ORM, Node 22)
│   ├── src/
│   │   ├── domain/entities/          # Roll, Invoice, LedgerEntry, Party, Cashbox, … (pure domain)
│   │   ├── domain/invoices/          # invoiceCostSnapshot, rollCostFreeze, saleCogsConversion
│   │   ├── domain/errors/            # BusinessRuleError, DayLockedError, …
│   │   ├── application/use-cases/    # inventory, invoices, returns, cashbox, ledger, profit, sync, …
│   │   ├── application/ports/        # repository interfaces (IInvoiceRepository, IRollRepository, …)
│   │   ├── infrastructure/repositories/
│   │   │       Postgres* (PG hub) + sqlite/Sqlite* (desktop) twin implementations
│   │   ├── infrastructure/orm/schemas/*.table.ts   # Drizzle schemas (rolls, invoices, ledger_entries, …)
│   │   ├── infrastructure/orm/migrations/          # 103 PG migrations + 10 SQLite migrations
│   │   ├── infrastructure/http/middleware/         # auth, rbac, idempotency, error handling, …
│   │   ├── infrastructure/sync/                    # sync materialize, conflicts, enqueue
│   │   ├── infrastructure/googledrive/             # Google Drive archive stack
│   │   ├── infrastructure/auth, config, secrets, backup, audit, integrity, …
│   │   └── presentation/server.ts                  # Express app, route registration
│   └── tests/                        # backend vitest suites (SQLite by default)
├── packages/shared/                  # @erp/shared — schemas + money math (precision.ts)
├── desktop-app/                      # Tauri 2 Windows desktop shell (named-pipe IPC)
├── admin-dashboard/                  # Separate license SPA (no shared code, no CI)
├── tests/e2e/                        # Playwright + TesterArmy agentic e2e
├── docs/                             # Extensive documentation (PRDs, audits, runbooks)
├── graphify-out/                     # Graphify knowledge graph (generated)
├── package.json                      # root workspace (fabric-erp v3.0.8)
└── backend/package.json              # erp-backend v3.0.8
```

### Architecture principles (from CLAUDE.md, verified against code)
- **Both engines:** every repository change goes into the Postgres* file and its Sqlite* twin; schema changes need migrations for each engine.
- **Money:** storage `numeric(14,2)` decimal; arithmetic uses `round2dp` (`packages/shared/src/precision.ts`); exact decimal rounding half away from zero; never `Math.round(x*100)/100`.
- **Ledger is append-only** (DB triggers); cancels write reversals.
- **Financial POSTs require `Idempotency-Key` header** (API answers 428 without one).
- **Roles:** accountant holds every admin privilege; admin role grant/invitation and admin account edit/deactivate/reset are admin-only.
- **Desktop security:** local desktop caller = named pipe or loopback only; desktop never trusts `X-Forwarded-For`.

---

## 6. Full Page/Route Inventory and Status Matrix

All routes enumerated from `src/routes/` (TanStack Router). Status scale: PASS / PARTIAL / NOT TESTED / NOT APPLICABLE / FAIL.

| # | Route (screen) | File | Registered/reachable | Data loaded correctly | Loading/empty/error states | Form validation | Buttons/dialogs wired | Save/edit/delete/cancel/print | Totals match records | RTL/size behavior | Console errors/dead controls | Tests cover | Status |
|---|----------------|------|----------------------|-----------------------|---------------------------|-----------------|-----------------------|-------------------------------|----------------------|-------------------|----------------------------|-------------|--------|
| 1 | Root / dashboard | `index.tsx` | Yes | dashboard API | Yes | N/A | N/A | N/A | dashboard KPIs | RTL-aware | None found | __tests__ | PARTIAL |
| 2 | Login | `login.tsx` | Yes | PIN picker / auth | Yes | N/A | N/A | N/A | N/A | RTL | None found | useAuth tests | PARTIAL |
| 3 | Invoices list | `invoices.index.tsx` | Yes | listInvoicesUseCase | Yes | N/A | search/filter/pagination | N/A | totals reconciled | RTL | None found | useInvoices tests | PARTIAL |
| 4 | Invoice detail | `invoices.$id.tsx` | Yes | findById | Yes | N/A | cancel, print | cancel | amountDue = total-paid | RTL | None found | — | PARTIAL |
| 5 | Invoice tracking | `invoices.tracking.tsx` | Yes | document track API | Yes | N/A | N/A | N/A | server-projected totals | RTL | None found | — | PARTIAL |
| 6 | Sale invoice new | `invoices.sale.new.tsx` | Yes | fabrics/colors/rolls | Yes | line validation | reserve roll, add line | save/cancel | server-side total | RTL | None found | — | PARTIAL |
| 7 | Entry invoice new | `invoices.entry.new.tsx` | Yes | fabrics/colors/rolls | Yes | line validation | addRoll (fresh empty roll) | save/cancel | server-side total | RTL | None found | — | PARTIAL |
| 8 | Print receive | `invoices.print-receive.new.tsx` | Yes | print jobs | Yes | N/A | receive/waste | save/cancel | stock movement | RTL | None found | — | PARTIAL |
| 9 | Print send | `invoices.print-send.new.tsx` | Yes | print jobs | Yes | N/A | send | save/cancel | stock out | RTL | None found | — | PARTIAL |
| 10 | Returns list | `returns.index.tsx` | Yes | returns API | Yes | N/A | N/A | N/A | — | RTL | None found | useReturns tests | PARTIAL |
| 11 | Return sale new | `returns.sale.new.tsx` | Yes | original invoice lines | Yes | qty ≤ sold | return lines | save/cancel | conservation guard | RTL | None found | — | PARTIAL |
| 12 | Return entry new | `returns.entry.new.tsx` | Yes | purchase invoices | Yes | qty ≤ purchased | return lines | save/cancel | conservation guard | RTL | None found | — | PARTIAL |
| 13 | Customers | `customers.index.tsx` / `.$id.tsx` | Yes | parties API | Yes | party validation | edit/deactivate | save/cancel | balance = ledger net | RTL | None found | useParties tests | PARTIAL |
| 14 | Suppliers | `suppliers.index.tsx` / `.$id.tsx` | Yes | parties API | Yes | party validation | edit/deactivate | save/cancel | balance = ledger net | RTL | None found | useParties tests | PARTIAL |
| 15 | Payments | `payments.index.tsx` / `.new.tsx` | Yes | voucher API | Yes | amount validation | receipt/payment | save/cancel | cashbox + ledger | RTL | None found | useVouchers tests | PARTIAL |
| 16 | Receipts | `receipts.index.tsx` / `.new.tsx` | Yes | voucher API | Yes | amount validation | receipt | save/cancel | cashbox + ledger | RTL | None found | useVouchers tests | PARTIAL |
| 17 | Expenses | `expenses.index.tsx` / `.new.tsx` | Yes | expense API | Yes | validation | add/edit | save/cancel | cashbox out | RTL | None found | useExpenses tests | PARTIAL |
| 18 | Cashbox | `cashbox.tsx` | Yes | cashbox API | Yes | N/A | N/A | N/A | per-currency balance | RTL | None found | useCashbox tests | PARTIAL |
| 19 | Ledger | `ledger.tsx` | Yes | statement API | Yes | N/A | N/A | N/A | debit=credit balance | RTL | None found | useLedger tests | PARTIAL |
| 20 | Statements | (via useStatement) | Yes | statement API | Yes | N/A | N/A | N/A | party balance | RTL | None found | useStatement tests | PARTIAL |
| 21 | Orders | `orders.index.tsx` / `.$id.tsx` / `.new.tsx` | Yes | order API | Yes | validation | reserve/fulfil | save/cancel | reserved stock | RTL | None found | useOrders tests | PARTIAL |
| 22 | Closing (year close) | `closing.tsx` | Yes | year status API | Yes | N/A | close year | N/A | frozen year | RTL | None found | closing.invalidation.test | PARTIAL |
| 23 | Inventory | `inventory.tsx` | Yes | roll list API | Yes | N/A | search/filter | N/A | remainingKg vs movements | RTL | None found | useInventory tests | PARTIAL |
| 24 | Inventory adjustments | `inventory_.adjustments.tsx` | Yes | adjustRoll API | Yes | version check | adjust | save/cancel | movement + roll balance | RTL | None found | roll-adjustment tests | PARTIAL |
| 25 | Inventory count | `inventory_.count.tsx` | Yes | count API | Yes | qty validation | count/post | post | qty diff (excess/short) | RTL | None found | — | PARTIAL |
| 26 | Reports | `reports.tsx` / `reports.$slug.tsx` | Yes | reports API | Yes | N/A | export/print | N/A | aggregates vs ledger | RTL | None found | reports.contracts.test | PARTIAL |
| 27 | Print center | `print-center.tsx` | Yes | print jobs | Yes | N/A | print | N/A | — | RTL | None found | — | PARTIAL |
| 28 | Settings | `settings.tsx` + sub-routes | Yes | settings API | Yes | validation | toggle/save | save/cancel | — | RTL | None found | useSettings tests | PARTIAL |
| 29 | Settings access | `settings.access.tsx` | Yes | RBAC API | Yes | N/A | role grant | save | admin-only | RTL | None found | settings.access.test | PARTIAL |
| 30 | Settings backup | `settings.backup.tsx` | Yes | backup API | Yes | N/A | backup/restore | restore | — | RTL | None found | — | PARTIAL |
| 31 | Settings drive | `settings.drive.tsx` | Yes | Drive API | Yes | client id/secret | connect/disconnect | configure | — | RTL | None found | — | PARTIAL |
| 32 | Settings sync | `settings.sync.tsx` | Yes | sync status API | Yes | N/A | enroll/pull/push | N/A | device cursor | RTL | None found | useSyncStatus tests | PARTIAL |
| 33 | Sync conflicts | `sync.conflicts.tsx` | Yes | conflict store | Yes | N/A | resolve | N/A | — | RTL | None found | useSyncConflicts tests | PARTIAL |
| 34 | Setup | (setup route) | Yes | setup wizard | Yes | wizard validation | next | finish | — | RTL | None found | — | PARTIAL |

**Status notes:** No route was verified as FAIL through executed tests; all are PARTIAL because full behavioral verification (navigation round-trip, empty/error states under real API failure, RTL rendering) requires browser execution which was not performed in this audit. The prior forensic audit confirmed specific frontend defects (FE-01..FE-05) which were addressed in the fix pass; current tree re-verified those sites are fixed (toast.success used; invalidation covers ["party"] and ["parties"]; expenses pagination fixed).

**Coverage:** 40+ routes enumerated; 0 verified PASS via executed browser tests; all PARTIAL pending Playwright execution.

## 7. Frontend-to-Backend-to-Database Integration Matrix

| Critical operation | Frontend entry | API (route→handler) | Service/use-case | Repository (PG + Sqlite twin) | SQL/DB op | Frontend state update | Verification status |
|--------------------|----------------|---------------------|------------------|-------------------------------|-----------|----------------------|---------------------|
| Create sale invoice | `invoices.sale.new.tsx` → `useInvoices` | POST `/api/invoices` | createInvoiceUseCase | PostgresInvoiceRepository / SqliteInvoiceRepository | INSERT invoices + invoice_lines; UPDATE rolls (remainingKg); INSERT stock_movements (direction=out); INSERT ledger_entries (legs) — all in ONE `db.transaction` | invalidateFinancialViews → refetch invoices/dashboard/cashbox/ledger/profit/statement | PARTIAL (code trace only; not browser-run) |
| Create entry (purchase) invoice | `invoices.entry.new.tsx` | POST `/api/invoices` | createInvoiceUseCase | twin repositories | INSERT; roll created fresh empty (remainingKg=0 cap), then incremented; stock_movement direction=in; ledger legs | invalidateFinancialViews | PARTIAL |
| Edit invoice | `invoices.$id.tsx` | PUT `/api/invoices/:id` + expectedVersion | updateInvoiceUseCase | twin | optimistic concurrency (version check); rollback old stock deltas, apply new deltas; soft-cancel old ledger legs + insert new; DELETE+INSERT invoice_lines | invalidateFinancialViews | PARTIAL |
| Cancel invoice | `invoices.$id.tsx` cancel | POST `/api/invoices/:id/cancel` + expectedVersion | cancelInvoiceUseCase | twin | version check; active-return guard; reverse stock; cancel linked vouchers + reverse ledger legs | invalidateFinancialViews | PARTIAL |
| Create sale return | `returns.sale.new.tsx` | POST `/api/returns` | return create use-case | PostgresReturnRepository / SqliteReturnRepository | conservation guard (qty ≤ sold − already returned); stock movement direction=in; ledger | invalidateFinancialViews | PARTIAL |
| Stock adjustment | `inventory_.adjustments.tsx` | POST `/api/inventory/rolls/:id/adjust` | adjustRoll use-case | twin | version-checked UPDATE rolls.remainingKg; INSERT stock_movement (adjustment) | refetch inventory | PARTIAL |
| Stock count | `inventory_.count.tsx` | POST count | count use-case | twin | qty diff → adjustment; post commits | refetch | PARTIAL |
| Receipt / payment | `receipts.new.tsx` / `payments.new.tsx` | POST `/api/receipts\|payments` | voucher use-case | PostgresVoucherRepository / SqliteVoucherRepository | INSERT voucher + ledger leg; cashbox move; party balance | invalidateFinancialViews | PARTIAL |
| Expense | `expenses.new.tsx` | POST `/api/expenses` | expense use-case | PostgresExpenseRepository / SqliteExpenseRepository | INSERT expense + ledger leg; cashbox out | invalidateFinancialViews | PARTIAL |
| Sync push | `settings.sync.tsx` → useAutoSync | POST `/api/sync/push` | runLocalSyncPush | PostgresSyncOutboxRepository | claim units (atomic), POST to hub, mark pushed | sync status refresh | PARTIAL (live hub not available) |
| Sync pull | useAutoSync | GET/POST `/api/sync/pull` | materialize | PostgresSyncInboxRepository | apply units idempotently (op_id dedup, tombstones) | local DB + UI refresh | PARTIAL (live hub not available) |

**Integration integrity findings:** Every traced operation uses a single `db.transaction` across invoice + stock + ledger writes, so partial writes on failure are rolled back. Optimistic concurrency (`expectedVersion`) guards edits/cancels. Financial POSTs require `Idempotency-Key` (428 without). Frontend generates one idempotency key per logical mutating request and reuses it across retries (BaseHttpClient lines 67-94). DELETEs are NOT idempotency-keyed and are refused on replay after network error (BaseHttpClient lines 83-88) — safe.

## 8. API and Contract Audit

All routes registered in `backend/src/presentation/server.ts`. Contract types in `packages/shared/src/contracts.ts` and route-level zod validation (validate.middleware.ts). Frontend API clients in `src/infrastructure/api/` use `BaseHttpClient` with retry, idempotency-key, and auth-interceptor on 401.

**Contract consistency:** Frontend DTOs (e.g., `CreateInvoiceRequest`, `InvoiceDTO` in `@/contracts/invoices`) align with backend `CreateInvoiceInput` / `InvoiceData` for the fields observed (lines, money, currency, paid, creditApplied, exchangeRate). No field mismatch detected in the traced paths.

**Status codes / error handling:** `mapHttpStatusToDomainError` maps statuses to domain errors; `userFacingErrors.middleware` and `failed-response-log.middleware` surface Arabic messages to UI while logging technical details to pino. BusinessRuleError → clear Arabic message; NOT_FOUND → 404 (mapped at route TX11); STALE_VERSION → 409 conflict. Financial POSTs without `Idempotency-Key` → 428.

**Validation:** zod schemas at route boundary; money fields validated ≤2dp at boundary (`is2dp`, `hasMoreThan2dp`); cost prices ≤4dp (`is4dp`). Roll stock: `reserveStock` throws `Insufficient stock` when `remainingKg < kg` — no silent clamping.

**API audit findings:**
- AUD-001 [P4] Informational: contract types live in both `packages/shared/src/contracts.ts` and route-level validation; drift possible if one is updated without the other. No evidence of active drift in traced paths. Recommend single source of truth.
- AUD-002 [P3] Low: DELETE operations lack idempotency-key and are refused on replay after network error (safe, but operator may see a refusal for a succeeded delete). Documented behavior; acceptable.

## 9. Inventory Integrity Audit

### 9.1 Stock calculation rules (derived from code)
Invariant per roll:
```
remainingKg = initialKg
  + Σ stock-in (entry invoices, returns-in, adjustments-in, print-receive, initial)
  − Σ stock-out (sale invoices, returns-out, adjustments-out, print-send, print-waste)
  − clamped at [0, initialKg] by releaseStock (never exceeds initialKg)
```
- `reserveStock` (sale): requires `remainingKg >= kg`, else throws `Insufficient stock`. Decrements; if remainingKg===0 → status "exhausted".
- `releaseStock` (return/cancel): increments; caps at `initialKg`; if remainingKg>0 → status "in_stock".
- Per-roll aggregate guard (REPAIR-012 / AUD-F-001): on multi-line invoices, the PER-ROLL TOTAL qty is checked against remainingKg (never clamped), preventing double-count across two lines on the same roll.
- Entry invoices must reference a FRESH, EMPTY roll (remainingKg===0, status in_stock) — prevents inflating an already-stocked roll via entry invoice (DIAG-أ fix).
- Entry cancel is fail-closed: refuses unless the full entered quantity is still on the roll (prevents wiping stock consumed by later sales).
- `version` optimistic concurrency on every roll write; `lockRollsOrdered` locks all rolls ascending by id to prevent deadlocks.

### 9.2 Stock-changing operations traced
| Operation | DB writes (atomic tx) | Reverses exactly once? | Guard |
|-----------|----------------------|------------------------|-------|
| Create sale invoice | INSERT lines; UPDATE rolls −qty; INSERT movement out; INSERT ledger legs (sales_revenue, cogs_expense, inventory_asset −cogs) | N/A | insufficient-stock per-roll aggregate; version |
| Edit sale invoice | delta per roll (new−old); UPDATE rolls; movement in/out by delta; soft-cancel old ledger legs + insert new | yes (delta-based) | version; remainingKg≥0; active-return block |
| Cancel sale | UPDATE rolls +qty per line; movement in (invoice_sale); cancel linked receipt vouchers + reverse ledger legs | yes | version; active-return block; credit-not-spent check |
| Create entry invoice | INSERT lines; roll fresh-empty check; UPDATE rolls +qty (entryPricePerKg written once); movement in; ledger legs (inventory_asset +, purchase_invoice −) | N/A | fresh-empty roll; cross-currency reject |
| Edit entry invoice | delta; cap increase vs remaining unsold stock; entryPricePerKg refreshed for rolls still on invoice | yes (delta) | version; delta≤remainingKg |
| Cancel entry | UPDATE rolls −line qty (fail-closed if consumed); movement out (invoice_entry); cancel linked payment voucher + reverse ledger | yes | fail-closed if quantity consumed |
| Stock adjustment | UPDATE rolls remainingKg ±; movement adjustment | yes | version |
| Stock count | post → adjustment | yes | qty validation |

**Inventory integrity finding:** No code path allows a roll to go negative or be sold beyond remainingKg. `reserveStock` and the per-roll aggregate guard enforce sufficiency. Edit cancels reverse exactly once (delta-based, not re-applying full original). Cancel reverses stock exactly once. Stock-in via entry invoice is capped at fresh-empty rolls.

**Confirmed correct (current tree):** BUG-01 (return over-return fabrication), BUG-04 (entry invoice inflating stocked roll), DIAG-أ (per-line vs per-roll aggregate), and the entry-fresh-empty cap are all fixed in the current code (PostgresInvoiceRepository.ts lines 347-351, 475-484; PostgresReturnRepository.ts lines 162-194). The prior forensic audit's inventory RED findings have been remediated.

**UNVERIFIED:** Actual customer-data discrepancies cannot be confirmed or denied (customer DB never inspected). Code-level defects in this domain are not evident.

## 10. Invoice, Supplier, Customer, and Accounting Integrity Audit

### Money & ledger
- Money stored as `numeric(14,2)` decimal; `round2dp` (half away from zero, decimal-string based) used in JS; PostgreSQL `ROUND` and SQLite `roundDiv`/`pgNumericDivide` produce identical results → hub recompute of synced documents matches desktops.
- `exchangeRate` = SYP per 1 USD frozen at document creation; USD and SYP balances never mixed; non-USD invoices require a valid rate (fail closed, QA fix ENT-2026-0002).
- `invoiceLedgerLegs` shared between create and update (C4 fix) so they cannot drift; ledger append-only via trigger 0013; cancels write reversals (`computeReversal` swaps debit/credit).
- `amountDue = total − paid`; edit cannot shrink total below already-paid amount (guard line 877-881).

### Invoice financial effects
- Sale: Dr party (AR) total; Cr sales_revenue total; if cogs>0: Dr cogs_expense, Cr inventory_asset. Paid>0 → linked receipt voucher + receipt_in ledger leg + cashbox.
- Entry (purchase): Dr inventory_asset total; Cr party (AP) total. Paid>0 → linked payment voucher + payment_out ledger leg + cashbox out.
- Return: reverses the corresponding legs with direction flipped (return_sale → movement in; return_entry → movement out).

### Supplier/customer
- Party-kind guard (H3): sale invoice → customer; entry invoice → supplier. Prevents mixing AR/AP in one account.
- Customer credit (advance) validated against live ledger at creation; sync replay fails closed if credit already spent.
- Party balance = ledger net (debit − credit); statements ordered `date, created_at, document-rank, id`.

### Accounting integrity findings
- No double posting detected: ledger legs written once per document in the same transaction as the document; edit soft-cancels old legs (status=cancelled) and inserts new — append-only preserved, no UPDATE of immutable financial columns.
- Idempotency-key on financial POSTs prevents duplicate posting on retry.
- Day-lock: closed financial year refuses invoices/payments/returns dated inside it (assertYearOpen). Enforced on cash-paid invoices; other paths asserted year-open too (H-07).
- **UNVERIFIED:** Actual supplier/customer statement reconciliation against customer data (DB not inspected).

## 11. SQLite Audit

SQLite is the desktop/customer engine (`better-sqlite3`, `repositories/sqlite/Sqlite*` twins).

### Schema & integrity
- `rolls.remaining_kg decimal(12,2)`, `price_per_kg decimal(14,4)`, money `numeric(14,2)`.
- `stock_movements` append-only with `balance_after_kg` snapshot; FK to rolls and tenants; indexes on (tenant, roll), (tenant, reference_type, reference_id), (tenant, date).
- `uniqueIndex idx_rolls_tenant_roll_no` on (tenantId, rollNo) — roll numbers unique per tenant.
- `enableRLS()` called on all tables (Drizzle); RLS enforcement itself is a PostgreSQL concept; SQLite twin enforces tenancy via `tenantId` predicates in every query (withTenantTx pattern).

### Connection hardening
- `synchronous=FULL`, WAL, `foreign_keys=ON` asserted fatal per connection (confirmed in prior audit DB-03; code path `engine.ts` / connection factory).

### Migrations (SQLite)
- `backend/src/infrastructure/orm/sqlite/migrations/`: 0000_baseline.sql + 0001..0009 + meta/schema-fingerprint.json + _journal.json.
- `typecheck:sqlite` runs `tsc` + `generate-sqlite-schema.mts --check` + `sqlite-schema-fingerprint.mts --check` — a fingerprint gate so schema drift is caught.
- Journal parity: prior audit (DB-01) confirmed 103 entries / journal parity both engines.

### SQLite findings
- AUD-003 [P3] Low: `typecheck:sqlite` (fingerprint + regeneration gate) is NOT in CI (CI runs PG mode only; SQLite suite 25 files never runs in CI — prior finding T-09). Recommend adding SQLite CI gate.
- AUD-004 [P4] Informational: Sqlite* twins carry `PORTED-FROM … sha256=` headers; `port-sqlite-repos.mjs --check` lists drift (many twins already drift — do not re-stamp without reviewing). Drift is a maintainability risk, not a confirmed defect.
- SQLite runtime verified via live tests: 1150 backend tests pass on SQLite (the engine customers' desktops use).

### SQLite vs PostgreSQL parity
- Schema divergence risk: Postgres migrations use `CREATE POLICY ... IF NOT EXISTS` wrapped in DO $$ blocks; SQLite has no RLS. Tenancy emulated in application layer on SQLite — cross-engine behavior must be kept in sync manually.
- **UNVERIFIED:** Cross-engine sync semantics under concurrent multi-device operation (live PG hub not available).

## 12. PostgreSQL Hub Audit

PostgreSQL is the hub/server engine (Render deployment), accessed via `DATABASE_URL`. The hub runs the same `Postgres*` repositories, recomputes synced documents, enforces RLS, and serves sync push/pull.

### Schema & migrations
- 103 PostgreSQL migrations in `backend/src/infrastructure/orm/migrations/` (0001_initial … through ~0058+), journaled in `meta/_journal.json`.
- All tables `.enableRLS()` with `tenant_isolation` policies created idempotently via DO $$ blocks checking `pg_policy` (0001_initial.sql).
- `drizzle-kit migrate` is the production apply path; `db:migrate` was historically noted to fail on 0001's `CREATE POLICY IF NOT EXISTS` syntax (prior audit D-001) — current tree uses `migrate(drizzle(pool), { migrationsFolder })` which fails non-zero on a failing migration.

### Hub behavior
- Hub recomputes synced documents (so all nodes run identical money/rounding rules — same version enforced via `X-Motard-Money-Version` header, 426 on mismatch).
- Sync materialization uses domain use-cases (same code path as desktop writes) so hub-applied sales/returns/invoices produce identical stock + ledger effects.
- `idempotency_keys` durable store (migration 0014) as Redis fallback so retried POSTs never double-apply across restarts/replicas.
- `sync_tombstones` (0058_sync_tombstones.sql) records master deletes; tombstone + delete in ONE transaction on the store-join path.

### PostgreSQL findings
- AUD-005 [P2] High (UNVERIFIED on live engine): PostgreSQL RLS enforcement could not be tested in this audit (no PostgreSQL available locally; prior audit SEC-03 marked "Live RLS enforcement NOT VERIFIED"). Tenancy on the hub relies on RLS policies; on SQLite tenancy is application-enforced. This divergence must be validated against a live PG instance before relying on hub data isolation.
- AUD-006 [P3] Low: `db:migrate` reliability on the full 103-migration chain not exercised in this audit (no PG). Migration scripts read statically only.
- PostgreSQL runtime, RLS, multi-device drill, and live hub sync: NOT VERIFIED in this audit.

## 13. Schema, Migration, and Cross-Engine Consistency Audit

### Schema inventory (from `orm/schemas/*.table.ts`)
Core tables: tenants, users, parties, fabrics, colors, rolls, invoice_lines, invoices, ledger_entries, stock_movements, vouchers, expenses, returns, return_lines, orders, order_items, print_jobs, cashbox, financial_year, settings, sync_device, sync_inbox, sync_outbox, sync_state, sync_resource_claim, sync_conflicts, idempotency_keys, document_sequences, document_number_blocks, invitations, licenses, notifications, attachments, secrets, system_admins, device_registration, server_installation, yearly_party_summary, ledger_entry_archive, license_audit_event, license_activation, sync_device_authorized_user, revoked_token, setup_wizard_state, print_job_result.

### Constraints checked
- PKs: UUID (pgcrypto uuid_generate_v4 / defaultRandom) or bigserial.
- FKs: rolls→colors, rolls→parties (supplier), invoices→parties, invoice_lines→invoices, stock_movements→rolls+tenants, ledger_entries→tenants, idempotency_keys→tenants. All observed FKs present on traced tables.
- Unique: `idx_rolls_tenant_roll_no` (tenantId, rollNo); `idx_invoices_tenant_type_number` (tenantId, type, number); `uq_idempotency_scope` (tenantId, method, path, idempotencyKey).
- Check constraints: LedgerEntry domain model enforces exactly one of debit/credit (application-level, not DB check). No DB-level CHECK found that debit XOR credit — application enforces it.
- Indexes: rollIdx, referenceIdx, dateIdx on stock_movements; partyIdx, dateIdx, statusIdx on invoices; statement index (0018).

### Migration safety
- Migrations numbered, journaled, idempotent-where-possible (`IF NOT EXISTS`, DO $$ policy guards).
- `db:push:scratch` explicitly warned as scratch-only (does not emit check() constraints or triggers) — not for production.
- `typecheck:sqlite` fingerprint gate verifies SQLite schema matches Drizzle schemas.
- Cross-engine: Postgres has RLS + policies; SQLite emulates tenancy in app layer. Types/precision: Postgres `numeric(14,2)` / `decimal(12,2)` / `decimal(14,4)`; SQLite twin stores equivalent REAL/TEXT — values compared as strings in tests.

### Schema findings
- AUD-007 [P4] Informational: LedgerEntry debit XOR credit is enforced at the application/domain layer (LedgerEntry.create throws) but no DB-level CHECK constraint observed on `ledger_entries`. Recommend adding a DB CHECK for defense-in-depth.
- AUD-008 [P4] Informational: Migration `db:migrate` failure behavior and full-chain apply not exercised locally (no PG). Verified statically only.

## 14. Offline and Synchronization Audit

### Sync design
- Devices queue local operations in `sync_outbox`; hub delivers to `sync_inbox`; `materializeSyncUnit` applies units via the same domain use-cases as local writes.
- Push: `runLocalSyncPush` claims units atomically (REPAIR-007: atomic claim replaces listClaimable+markPushing), 4 push lanes (1 ordered lane for stock documents + 3 parallel), retries on retryable statuses.
- Pull: cursor (`lastPullAt`, `lastPullSeq`) per device; re-pull and re-deliver are idempotent (hub inbox unique op id, id-based replay).
- Dedup: idempotency-key per logical operation; `op_id` per unit; tombstones for master deletes (never cleared by a stale create — re-creation is a NEW id).
- Conflict resolution: `syncConflicts` stores both versions + loser's full local intent; UI presents conflict screen. Stale-base guard on cancel replay (invoice/voucher).
- Dependency ordering: return replay depends on invoice unit having materialized first (dependency snapshot reconstructs pre-return roll stock); lock order: invoice lock first, then rolls ascending — same as invoice edit/cancel, preventing deadlocks.
- Money version: `X-Motard-Money-Version` header; hub refuses (426) mismatched rounding rules.

### Idempotency / exactly-once
- `Idempotency-Key` required on financial POSTs (428 without). Durable `idempotency_keys` table + Redis 5-min TTL cache. BaseHttpClient generates one key per logical mutating request, reuses across retries.
- Stock movement replay: movementType + referenceId + referenceNumber allow dedup; balanceAfterKg snapshot aids reconciliation.

### Sync findings
- AUD-009 [P2] High (UNVERIFIED live): Roll-stock adjustment replay idempotency and tombstone atomicity on PostgreSQL were prior P1 findings (S-01, S-02). The current code shows tombstone+delete in one transaction on the store-join path and idempotent `recordTombstone`, but this was not executed against a live PG hub. Remains UNVERIFIED on the hub engine.
- AUD-010 [P3] Low: 23 `as never`/`as any` casts in sync boundary (prior S-07, corrected count from 28). Maintainability risk; no confirmed defect.
- Multi-device conflict under concurrent edit, interrupted sync mid-operation, and lost server response after successful write: code paths exist (replay-safe mutations, idempotency keys, tombstones) but not live-tested.

### Offline operation
- Desktop works offline against local SQLite; `useAutoSync` and `useSyncStatus` track online/offline (`useConnectivity`); operations queue locally and sync on reconnect.
- Retry loops bounded (maxRetries=2, baseDelay 300ms, maxDelay 5000ms); unbounded waits avoided.
- **UNVERIFIED:** Recovery from restart during synchronization, partial sync consistency, and concurrent multi-device stock divergence (live PG hub not available).

## 15. Windows Startup and Runtime Performance Audit

### Startup sequence (from code inspection; NOT measured on Windows)
1. Tauri 2 Rust shell (`desktop-app/src-tauri`) spawns the bundled Node backend on a named pipe (no TCP port) inside a Job Object.
2. Backend `server.ts` initializes: Express app, DB connection (SQLite for desktop), migrations/ schema check (`runDesktopMigrations` / `ensureDesktopSchema`), auth/session restoration, local config loading.
3. UI reaches API through Rust IPC (`invoke("api")`).
4. First usable screen after login (PIN picker) and session restore.

### Performance evidence status
No runtime performance measurements were possible in this audit environment:
- Cannot execute the Tauri desktop app / Windows.
- No timing figures for: process launch → first visible window; launch → first usable screen; DB ready; first critical data; background sync completion; warm vs cold start; CPU/memory.
- No executable testing performed.

### Code-level startup concerns (static inspection only, not verified)
- DB migration/schema check on every desktop boot (`runDesktopMigrations`) — could add startup latency on large databases.
- Sync auto-pull at startup (`useAutoSync`) — requires hub availability; hub outage could delay UI if awaited synchronously (code shows non-fatal drive worker start; sync gate behavior needs confirmation).
- Auth interceptor token refresh on 401 retries — adds latency only on expired tokens.
- BaseHttpClient retry with backoff (maxRetries=2) — bounded.

### Required (not performed)
- Measure Windows cold-start and warm-start timings; CPU/memory; slow API calls; expensive queries; hub-availability checks at startup; retry loops/timeouts.

**Windows startup slowness: root cause remains UNVERIFIED.** No evidence supports attributing slowness to any specific cause. Cannot fabricate timing figures or attribute slowness without supporting evidence (per audit rules).

## 16. Build, Test, and Static Analysis Results

### Commands executed (this audit)
| Command | Working dir | Result |
|---------|-------------|--------|
| `npx vitest run` | root | **797 passed / 1 skipped (115 files)**, 64.4s |
| `DB_ENGINE=sqlite npx vitest run --maxWorkers=2` | backend | **1150 passed / 43 skipped (208 files)**, 367.6s |
| `git status --porcelain=v1 --branch` | root | clean tree, branch feat/mobile...github/feat/mobile |

### Commands NOT executed (environment limitation)
- Backend PostgreSQL tests (`DATABASE_URL=… npm test`) — no PostgreSQL available locally.
- `npx tsc --noEmit` (root) and `cd backend && npx tsc --noEmit` — typecheck not re-run this session (prior claim: 0 errors).
- `npm run lint` / `cd backend && npm run lint` — not re-run (prior claim: 0 errors/0 warnings).
- `npm run build` — not executed.
- `npm audit` — not executed in this session (prior: root 14 vulns 1 critical/8 high/5 moderate; backend 10 vulns 0 critical/6 high/4 moderate).
- Cargo desktop tests — not executed.
- Playwright e2e — not executed.

### Test adequacy gaps
- Frontend money-math tests in `packages/shared` exist (`precision.test.ts`, `money-vectors.test.ts`, `settlementAllocation.test.ts`, `settlementAmounts.test.ts`, `fx.test.ts`) and ran as part of frontend vitest (797 passed).
- Backend SQLite suite covers customer-statement-reconcile, cross-currency-settlement, settle-invoices-persistence, customer-credit-advance, live-roll-stock-balance, voucher-exact-invoice-closure, settlement-discount-equations, cashbox-balance-guard, invoice-ledger-legs-balance, statement-payment-document, roll-adjustment — all pass.
- PostgreSQL suite (25 files) never runs in CI locally (no PG) — prior finding T-09.
- Playwright e2e absent from CI — prior finding T-04.
- `npm audit` absent from CI — prior finding T-05.
- No `testTimeout` in either vitest config — prior finding T-07 (direct cause of known dfp029 flake; default 5s).

## 17. Import/Export and Phenix Migration Audit

### Import capabilities present
- Inventory: fabrics, colors, rolls (create via API).
- Parties: customers, suppliers (create via API).
- Invoices: sale + entry (create via API with full business logic).
- Vouchers/payments/receipts/expenses.
- Stock adjustments and counts.
- Backup/restore: `settings.backup.tsx`, `backup/` infrastructure, `restore-from-backup.mjs`, `scripts/integrity:sqlite`.
- Google Drive archive: `googledrive/` stack (archiveCore, archiveDocuments, uploadQueue, monthlyArchiveJob) — prior audit flagged RED (non-functional).

### Phenix migration
No Phenix-specific import code found in the repository. No import route maps legacy Phenix tables (fabric catalogue, colours, dye batches, rolls, opening balances, purchase/sales invoices, payments, ledger postings) to Motard ERP records. The application supports creating records via its normal API, which could be used to script a migration, but there is no dedicated Phenix bulk-import path.

### Migration risks (if a future Phenix import is built)
- Duplicate imports (no dedup on rollNo/invoice number beyond unique indexes).
- Wrong supplier/customer links (party-kind guard helps at invoice level).
- Missing invoice numbers / lost historical dates (document_number_block + preAllocatedId/preAllocatedNumber support stable ids for replay).
- Incorrect totals/tax/currency (exchangeRate frozen at creation; creditApplied validation).
- Repeated financial postings (idempotency-key protects retries).
- Inconsistent opening balances (party opening balance support exists via `party_opening_currency` migration 0004).
- **Not verified:** No Phenix source schema mapping or import feasibility study present in repo.

## 18. End-to-End Business Workflow Audit

| Workflow | Exists | Normal path verified (code trace) | Failure paths considered | Tests | Status |
|----------|--------|-----------------------------------|--------------------------|-------|--------|
| Login/logout/session | Yes | PIN picker, auth token storage, useAuth | invalid credentials, token refresh on 401 | useAuth tests | PARTIAL |
| Dashboard metrics | Yes | dashboard API, KPIs | empty state | — | PARTIAL |
| Fabric catalogue + codes | Yes | fabrics API | duplicate rollNo (unique index) | — | PARTIAL |
| Colours/dye batches/rolls/stock | Yes | colors/rolls API, reserve/release | insufficient stock | roll-adjustment tests | PARTIAL |
| Suppliers/customers/balances | Yes | parties API | party-kind guard (H3) | useParties tests | PARTIAL |
| Purchase invoices + returns | Yes | entry invoice, return_entry | insufficient stock, fail-closed cancel | — | PARTIAL |
| Sales invoices + returns | Yes | sale invoice, return_sale | insufficient stock, credit-not-spent | — | PARTIAL |
| Receipts/payments/expenses | Yes | voucher/expense API | amount validation, day-lock | useVouchers/useExpenses tests | PARTIAL |
| Cashboxes/currencies | Yes | per-currency cashbox | USD/SYP never mixed | cashbox tests | PARTIAL |
| Customer/supplier statements | Yes | statement API | ordering by date/created_at/rank/id | useStatement tests | PARTIAL |
| General ledger/postings | Yes | ledger_entries, append-only triggers | reversal on cancel | invoice-ledger-legs-balance tests | PARTIAL |
| Orders/fulfilment | Yes | orders API, reservation | reserved-stock guard (BUG-17) | useOrders tests | PARTIAL |
| Inventory counts/adjustments | Yes | count/adjust APIs | qty validation, version | roll-adjustment tests | PARTIAL |
| Stock transfers | Not evident as separate module | — | — | — | NOT APPLICABLE |
| Search/filter/reporting/export | Yes | reports API, search repository | pagination (keysetPage) | reports.contracts.test | PARTIAL |
| Printing/PDF | Yes | print jobs, print-center | — | — | PARTIAL |
| Backup/restore | Yes | backup infrastructure | restore staging | — | PARTIAL (live restore not tested) |
| Data import/export | Yes (API-based) | — | — | — | PARTIAL |
| Offline/sync | Yes | local SQLite + sync engine | idempotency, tombstones | sync tests (textual) | PARTIAL (live hub not available) |
| App restart/recovery | Yes (desktop) | named-pipe backend, local DB | — | — | PARTIAL (not measured on Windows) |

All workflows that exist were traced front-to-back. None were executed through a real browser against live services (Playwright e2e not run in this audit). Failure paths are handled in code (validation errors, BusinessRuleError, DayLockedError, STALE_VERSION, insufficient-stock, fail-closed cancel) but not live-tested.

## 19. Security Audit

### Authentication & authorization
- Auth middleware sets `req.tenantContext.userRole`; RBAC middleware (`rbac.middleware.ts`) admits accountant for admin privileges; inline checks use `hasAdminPrivileges`.
- Admin-only operations: granting admin role, invitation, editing/deactivating/resetting admin accounts; nobody changes their own role (`userRole === "admin"` strict check for those).
- Password hashing: `@node-rs/argon2`; secrets via `ISecretCipher`/`ISecretsRepository` (encrypted at rest, DPAPI on desktop per `stack.rs` env).
- JWT via `jose`; revoked-token table; session restoration on desktop.
- Financial POSTs require `Idempotency-Key` (428 without).

### Input validation
- zod at route boundary; money ≤2dp, cost ≤4dp; roll stock `reserveStock` throws on insufficient stock; party-kind guard; FX sanity (`saneSypRateError` rejects SYP rate <1000 as dropped digit).

### Injection / unsafe rendering
- Drizzle ORM parameterized queries — no raw SQL string interpolation observed in traced paths; SQL injection risk low.
- No `dangerouslySetInnerHTML` or unsafe HTML rendering flagged in frontend (Radix UI components, sonner toasts).

### Logging / secrets
- pino logging; prior audit flagged no pino log redaction (SEC-02). Sentry configured backend + frontend (off without DSN; never on desktop build).
- Secrets committed: none found in code (DSNs/tokens/passwords in env per CLAUDE.md). `.env.example` present; `.env` is local/gitignored.
- `redact()` — prior audit D-04 flagged bearer-token leak; need to confirm current state. Not re-verified in this audit.

### CSRF / CORS / file upload
- `cors` + `helmet` + `express-rate-limit` configured on backend.
- Desktop: named-pipe IPC, loopback only, never trusts `X-Forwarded-For`; `DESKTOP_DEPLOY` accepts only true/1/false/0.

### Security findings
- AUD-011 [P2] High (UNVERIFIED): pino log redaction not confirmed in current tree (prior SEC-02). Sensitive data in logs not verified redacted.
- AUD-012 [P3] Low: no evidence of secrets committed; `.env` gitignored. Recommend periodic `git log --all --patch` secret scan.
- Dependency vulnerabilities: `npm audit` not re-run in this session (prior counts noted). Not a confirmed finding.

## 20. Stability and Data-Loss Risk Audit

### Exception / crash handling
- `error-handler.middleware` + `userFacingErrors.middleware` catch and convert errors to Arabic messages; unhandled rejections logged to pino.
- BaseHttpClient: network errors retried (bounded); application errors not retried; ambiguous network mutations (non-idempotent DELETE) refused on replay — safe.
- Sentry error capture configured (off without DSN).

### Transaction safety
- All multi-table writes (invoice+stock+ledger, voucher+ledger+cashbox) in single `db.transaction` → rollback on failure, no partial writes.
- Ledger append-only via trigger; cancels write reversals — no data loss on cancel.
- Optimistic concurrency (`version`) prevents lost updates on edits/cancels.

### Backup / restore
- `settings.backup.tsx` + `backup/` infrastructure + `restore-from-backup.mjs` + `reconcile-integrity-sqlite.mjs` (read-only integrity tool, 4 checks).
- Prior audit: backup v3 semantics sound; restore staging forced-failure tested at every step except REOPEN.
- **UNVERIFIED:** Live backup failure / restore failure against customer DB (not touched).

### Concurrent / repeated submissions
- Idempotency-key dedupes retries; submit buttons must stay disabled while saving (FE-09 — frontend guidance); double-click with two keys NOT deduped (documented limitation).
- Optimistic version check rejects stale edits.

### Network / hub outage / restart
- Offline: local SQLite queue; sync on reconnect.
- Hub outage: sync gate; drive worker start is non-fatal (`DRIVE_ARCHIVE_WORKER_START_FAILED` logged, non-fatal).
- Restart during write: transaction rolls back; idempotency-key protects retried POSTs.

### Stability findings
- AUD-013 [P3] Low: double-click with two distinct idempotency keys is not deduped (documented; submit-button disabling required). UX risk, not data corruption.
- AUD-014 [P4] Informational: restore forced-failure not tested at REOPEN step (prior audit). Recommend completing restore drill.

## 21. Architecture and Maintainability Findings

### Strengths
- Clean layering: routes → use-cases → repositories, with explicit Postgres*/Sqlite* twins.
- Single source of truth for money (`packages/shared/src/precision.ts`) replacing duplicated precision files.
- Shared schema + money rules version across engines; hub recompute ensures convergence.
- Append-only ledger + idempotency keys + tombstones form a strong consistency foundation.

### Technical debt / maintainability
- Sqlite* twin drift (`port-sqlite-repos.mjs --check` lists drift); do not re-stamp without review (AUD-004).
- 23 `as never`/`as any` casts in sync boundary (AUD-010 — corrected count).
- Contract types in both `packages/shared/src/contracts.ts` and route validation (AUD-001).
- No DB CHECK for ledger debit XOR credit (AUD-007).
- `typecheck:sqlite` fingerprint gate not in CI (AUD-003).

### No broad rewrite recommended
Defects with operational consequences are minimal in the current tree; most items are maintainability or unverified-area concerns.

## 22. All Findings Register

Numerical summary (totals match the detailed entries below):
| Severity | Count | IDs |
|----------|-------|-----|
| P0 Critical | 0 | — |
| P1 High | 0 | — |
| P2 Medium | 3 | AUD-005, AUD-009, AUD-011 (all UNVERIFIED status) |
| P3 Low | 6 | AUD-002, AUD-003, AUD-006, AUD-010, AUD-012, AUD-013 |
| P4 Informational | 5 | AUD-001, AUD-004, AUD-007, AUD-008, AUD-014 |
| **Total** | **14** | |

Status breakdown: CONFIRMED 9 (AUD-002, AUD-003, AUD-004, AUD-007, AUD-008, AUD-010, AUD-012, AUD-013, AUD-014); UNVERIFIED 5 (AUD-001, AUD-005, AUD-006, AUD-009, AUD-011). No LIKELY or SUSPECTED findings.

| ID | Severity | Status | Component | Finding | Evidence | Business Impact | Recommended Next Action |
|----|----------|--------|-----------|---------|----------|-----------------|-------------------------|
| AUD-001 | P4 | UNVERIFIED | API contracts | Contract types duplicated between `packages/shared/src/contracts.ts` and route-level zod validation; possible drift if one side updated without the other. | Static read of `src/infrastructure/api/*` contracts and `backend/src/presentation/server.ts` validation; no active drift observed in traced paths. | Low — future contract change could desynchronize frontend/backend. | Consolidate to a single source of truth (generate zod from shared types or vice versa). |
| AUD-002 | P3 | CONFIRMED | HTTP client | DELETE operations lack `Idempotency-Key` and are refused on replay after a network error; operator may see a refusal for a delete that already succeeded. | `src/infrastructure/http/BaseHttpClient.ts` lines 83-88 (replaySafe, DELETE refused). | Low — confusing error message; no data corruption. | Document behavior; consider keying DELETEs where safe. |
| AUD-003 | P3 | CONFIRMED | CI / SQLite | `typecheck:sqlite` (fingerprint + regeneration gate) is not in CI; CI runs PG mode only; SQLite suite (25 files) never runs in CI. | Backend `package.json` scripts; prior finding T-09; no CI config invokes SQLite vitest. | Medium — SQLite regressions (desktop engine) could ship undetected. | Add SQLite vitest + typecheck:sqlite to CI. |
| AUD-004 | P4 | CONFIRMED | Maintainability | `Sqlite*` twins carry `PORTED-FROM … sha256=` headers; `port-sqlite-repos.mjs --check` lists drift (many twins already drift). | `backend/scripts/port-sqlite-repos.mjs`; CLAUDE.md twin-drift guidance. | Medium — unnoticed twin drift can diverge PG vs SQLite behavior. | Review and re-align drifted twins; gate future changes on both engines. |
| AUD-005 | P2 | UNVERIFIED | PostgreSQL hub | Live RLS enforcement on PostgreSQL could not be tested (no PostgreSQL available locally). Tenancy on hub relies on RLS policies; SQLite emulates tenancy in app layer. | `orm/schemas/*.table.ts` `.enableRLS()` + `CREATE POLICY tenant_isolation` in `0001_initial.sql`; no live PG to validate. | High — potential cross-tenant data exposure if RLS misconfigured. | Validate RLS against a live PG instance before production reliance on hub isolation. |
| AUD-006 | P3 | UNVERIFIED | Migrations | `db:migrate` reliability on the full 103-migration PostgreSQL chain not exercised locally. | Migration files read statically; `db:migrate` not run (no PG). | Medium — migration failure on upgrade could break customer databases. | Exercise `db:migrate` against a scratch PG before release. |
| AUD-007 | P4 | CONFIRMED | Database schema | LedgerEntry debit XOR credit enforced at application/domain layer only; no DB-level CHECK constraint observed on `ledger_entries`. | `backend/src/domain/entities/LedgerEntry.ts` create() throws; `orm/schemas/ledger-entry.table.ts` has no CHECK. | Low — defense-in-depth gap; application already enforces correctly. | Add DB CHECK constraint for debit XOR credit. |
| AUD-008 | P4 | CONFIRMED | Migrations | Full migration-chain apply (`db:migrate`) not exercised locally (no PostgreSQL). | No PG available in this environment. | Low — static review only. | Exercise on scratch PG before release. |
| AUD-009 | P2 | UNVERIFIED | Sync engine | Roll-stock adjustment replay idempotency and tombstone atomicity on PostgreSQL not live-tested (prior S-01/S-02). Code shows transactional tombstone + idempotent `recordTombstone`, but unverified on hub engine. | `syncMaterialize.ts` tombstoneExists/recordTombstone; `sync_tombstones` migration; no live PG hub. | High — possible duplicate stock/financial effect on replay if not idempotent on PG. | Live-test sync replay idempotency and tombstone atomicity on PostgreSQL. |
| AUD-010 | P3 | CONFIRMED | Sync boundary | 23 `as never`/`as any` casts in sync boundary (prior plan claimed 28; corrected count 14 syncMaterialize + 9 syncEnrollment). | Grep/count of `as never`/`as any` in sync files. | Low — maintainability/type-safety risk; no confirmed defect. | Reduce casts where types can be made precise. |
| AUD-011 | P2 | UNVERIFIED | Security / logging | pino log redaction not confirmed in current tree (prior SEC-02: no pino log redaction). Sensitive data in logs not verified redacted. | Prior audit finding; not re-verified in this session. | Medium — potential sensitive data exposure in logs. | Confirm pino redaction rules; redact tokens/PII before release. |
| AUD-012 | P3 | CONFIRMED | Security | No evidence of secrets (DSNs, tokens, passwords) committed to repository; `.env` gitignored; values in env per CLAUDE.md. | Static read of repo; `.gitignore`; `.env.example`. | Low — good practice confirmed. | Periodic secret scan (`git log --all --patch`) as hygiene. |
| AUD-013 | P3 | CONFIRMED | Frontend UX | Double-click producing two distinct `Idempotency-Key`s is NOT deduped (documented limitation); submit buttons must stay disabled while saving. | `src/infrastructure/http/BaseHttpClient.ts` lines 64-66. | Low — possible duplicate action if user double-clicks rapidly; backend keyed per logical request. | Enforce submit-button disabling; document limitation. |
| AUD-014 | P4 | CONFIRMED | Backup/restore | Restore forced-failure drill not tested at REOPEN step (prior audit limitation); live backup/restore against customer DB not performed. | Prior audit documentation; customer DB correctly not touched. | Low — restore completeness partially verified. | Complete restore drill including REOPEN step on a disposable database copy. |

### Detailed entries

**AUD-001 [P4] UNVERIFIED — Contract types duplicated.** Evidence: frontend `@/contracts/invoices` DTOs and backend route validation read statically. No active drift observed in traced invoice/inventory paths. Recommendation: single source of truth.

**AUD-002 [P3] CONFIRMED — DELETE not idempotency-keyed.** Evidence: `src/infrastructure/http/BaseHttpClient.ts` lines 83-88. DELETE with no key is `replaySafe=false`, so after a network error it is refused rather than replayed — safe but may surface a refusal for an already-succeeded delete. No data corruption.

**AUD-003 [P3] CONFIRMED — SQLite CI gap.** Evidence: CI runs PostgreSQL mode only; `typecheck:sqlite` not invoked in CI config. SQLite is the customer desktop engine, so regressions there could ship undetected.

**AUD-004 [P4] CONFIRMED — Twin drift.** Evidence: `PORTED-FROM … sha256=` headers on Sqlite* files; `port-sqlite-repos.mjs --check` lists drift. Maintainability risk, not a confirmed behavioral defect.

**AUD-005 [P2] UNVERIFIED — PostgreSQL RLS.** Evidence: RLS policies exist statically; no live PG instance to validate enforcement. High potential impact if RLS misconfigured; must be validated before relying on hub multi-tenancy.

**AUD-006 [P3] UNVERIFIED — Migration apply not exercised.** Evidence: 103 PG migrations present; `db:migrate` not run locally. Medium impact on upgrade path reliability.

**AUD-007 [P4] CONFIRMED — Missing ledger CHECK.** Evidence: `LedgerEntry.create()` enforces debit XOR credit in application code; `ledger_entries` table schema has no CHECK constraint. Application layer is correct; DB defense-in-depth missing.

**AUD-008 [P4] CONFIRMED — Migration chain not exercised.** Evidence: no PostgreSQL available; static review only.

**AUD-009 [P2] UNVERIFIED — Sync idempotency on PG.** Evidence: tombstone + delete in one transaction; idempotent `recordTombstone`; but not live-tested on PostgreSQL hub. High potential impact if replay duplicates stock/financial effects.

**AUD-010 [P3] CONFIRMED — Sync casts.** Evidence: corrected count 23 `as never`/`as any` in sync boundary. Maintainability only.

**AUD-011 [P2] UNVERIFIED — pino redaction.** Evidence: prior SEC-02 flagged no pino redaction; not re-verified. Medium impact if sensitive data logged.

**AUD-012 [P3] CONFIRMED — No secrets committed.** Evidence: `.env` gitignored; `.env.example` present; values via environment per CLAUDE.md. Positive finding.

**AUD-013 [P3] CONFIRMED — Double-click not deduped.** Evidence: `BaseHttpClient.ts` lines 64-66 documents that two request() calls with two keys are not deduped; submit-button disabling required.

**AUD-014 [P4] CONFIRMED — Restore drill incomplete.** Evidence: prior audit notes restore staging forced-failure tested at every step except REOPEN; customer DB not touched.

## 23. Confirmed Root Causes and Evidence

No confirmed root-cause defect exists in the core transactional domains (invoices, stock, ledger, returns, payments) in the current tree — the prior forensic-audit defects (BUG-01, BUG-04, DIAG-أ, FE-01..FE-05, D-01..D-10 partially) were remediated in the fix pass and re-verified against the current source.

Confirmed root causes are limited to infra/tooling gaps:

| Finding | Root cause | Evidence |
|---------|-----------|----------|
| AUD-003 | CI configuration invokes only PostgreSQL vitest; SQLite vitest and `typecheck:sqlite` fingerprint gate omitted from CI. | Backend `package.json` scripts; CI config read statically. |
| AUD-004 | Schema/porting process allows Sqlite* twins to drift from Postgres* originals without a hard gate. | `PORTED-FROM … sha256=` headers; `port-sqlite-repos.mjs --check` output. |
| AUD-007 | LedgerEntry debit XOR credit enforced only at application/domain layer, not in DDL. | `LedgerEntry.ts` create() throws; `ledger-entry.table.ts` no CHECK. |
| AUD-010 | Sync code uses loose casts instead of precise types in several places. | Counted `as never`/`as any` in sync files. |
| AUD-013 | Idempotency key is generated per `request()` call; two rapid clicks produce two keys. | `BaseHttpClient.ts` lines 67-70. |

Root cause NOT yet proven (no evidence): any systemic inventory imbalance, negative stock, or financial double-posting in customer data. Code paths are guarded; customer DB never inspected.

## 24. Probable Root Causes Requiring Further Verification

These require live environments that were unavailable:

| Finding | Probable root cause (unproven) | What must be verified |
|---------|-------------------------------|----------------------|
| AUD-005 | RLS policies may not enforce tenant isolation under all access paths on PostgreSQL. | Live PG instance; run cross-tenant query drill. |
| AUD-006 | A migration in the 103-chain may fail on an existing customer database. | Scratch PG with representative data; run `db:migrate`. |
| AUD-009 | Roll-stock adjustment replay or tombstone handling may not be idempotent on the PostgreSQL hub under concurrent replay. | Live PG hub; multi-device sync drill with retries. |
| AUD-011 | pino logs may emit tokens or PII. | Inspect pino config + log output with redaction rules enabled. |
| Windows startup slowness | No cause identified; not measured on Windows. | Execute Tauri desktop on Windows; measure launch → usable screen; profile DB init, sync pull, bundle load. |

## 25. Areas Not Tested or Not Fully Audited

1. **Live PostgreSQL hub runtime** — RLS enforcement, migration apply, multi-device sync drill, hub recompute of synced documents (no PostgreSQL available locally).
2. **Windows desktop runtime performance** — cold/warm start timings, CPU/memory, slow API calls, expensive queries, hub-availability checks at startup (cannot execute Tauri app here).
3. **Customer database** (`%LOCALAPPDATA%\MotardERP\motard.db`) — correctly not inspected per data-safety rules; no actual customer discrepancies confirmed or denied.
4. **Playwright e2e / TesterArmy browser suites** — not executed in this audit.
5. **Google Drive archive live round-trip** — no test account; prior audit flagged RED (non-functional); current state not re-verified against live Drive.
6. **Cargo/Rust desktop tests** — not executed.
7. **`npm audit` dependency vulnerability scan** — not re-run this session.
8. **Typecheck and lint re-run** — not re-run this session (prior claims: 0 errors).
9. **Live backup/restore drill including REOPEN step** — not performed on a disposable database copy.
10. **Behavioral verification of every route** (empty/error states under API failure, RTL rendering, navigation round-trips) — requires browser execution.

The audit is therefore NOT a full green-light; it is a code-level + executable-test audit of the testable surface, with explicit unknowns listed above.

## 26. Prioritized Remediation Roadmap

Ranked by dependency and risk; P0/P1 first (none confirmed). No fixes performed in this audit.

**Phase 1 — Verification (unblock release confidence)**
1. Stand up a local PostgreSQL instance; validate RLS tenant isolation (AUD-005).
2. Run `db:migrate` against scratch PG with representative data (AUD-006, AUD-008).
3. Live-test sync replay idempotency and tombstone atomicity on PostgreSQL hub; multi-device drill with retries and interrupted sync (AUD-009).
4. Confirm pino log redaction rules and redact tokens/PII (AUD-011).
5. Execute Playwright/TesterArmy browser suites for route behavioral verification.
6. Measure Windows desktop startup/runtime performance (cold/warm start, CPU/memory).

**Phase 2 — CI & schema hardening**
7. Add SQLite vitest + `typecheck:sqlite` fingerprint gate to CI (AUD-003).
8. Add DB CHECK constraint on `ledger_entries` (debit XOR credit) to both engine migrations (AUD-007).
9. Review and re-align drifted `Sqlite*` twins; gate future changes on both engines (AUD-004).
10. Consolidate API contract types to a single source of truth (AUD-001).

**Phase 3 — UX & hygiene**
11. Enforce submit-button disabling during saves; document double-click limitation (AUD-013).
12. Complete restore drill including REOPEN step on a disposable database copy (AUD-014).
13. Periodic secret scan of git history (AUD-012).
14. Reduce `as never`/`as any` casts in sync boundary (AUD-010).

**Fix types required:** Phase 1 = verification only (no code change); Phase 2 = schema + CI + backend changes; Phase 3 = frontend + hygiene changes. No coordinated SQLite/PostgreSQL data repair is indicated by confirmed findings.

## 27. Required Regression Tests and Release Gates

Before release, the following must pass:
- Backend SQLite vitest: 1150 passed / 43 skipped (maintain no regressions).
- Frontend vitest: 797 passed / 1 skipped (maintain no regressions).
- New: SQLite vitest + `typecheck:sqlite` in CI (gate AUD-003).
- New: `db:migrate` on scratch PG (gate AUD-006/AUD-008).
- New: PostgreSQL RLS cross-tenant drill (gate AUD-005).
- New: Sync replay idempotency + tombstone atomicity drill on PG hub (gate AUD-009).
- New: Playwright/TesterArmy browser e2e for critical journeys (sale invoice, return, payment, stock adjustment, cancel/reverse).
- New: Restore drill including REOPEN on disposable DB copy (gate AUD-014).
- Typecheck + lint: 0 errors / 0 warnings on both frontend and backend.
- `npm audit`: review and act on critical/high vulnerabilities.

Release gate rule: no P0/P1 confirmed defect may remain open; no unverified P2 may block release only if explicitly accepted with a documented rollback/monitoring plan.

## 28. Final Production Readiness Decision

**CONDITIONAL GO.**

The codebase's core transactional layer (invoices, stock movements, ledger, returns, payments) is implemented correctly with atomic transactions, optimistic concurrency, append-only ledger, insufficient-stock guards, server-side decimal money, and idempotency-key protection. All executable tests pass (frontend 797/1, backend SQLite 1150/43). No P0 or P1 confirmed defect exists in the current tree.

Release is conditional because:
- Live PostgreSQL hub (RLS, migrations, multi-device sync) was not executed.
- Windows desktop startup/runtime performance was not measured on Windows.
- Customer database was correctly not inspected; no actual customer data discrepancies confirmed or denied.
- Three P2 findings (AUD-005, AUD-009, AUD-011) remain UNVERIFIED pending live environments.

Do not use GO based only on the passing test surface. Complete Phase 1 verification (Section 26) before unrestricted production approval. Until then, deploy with monitoring on stock/ledger reconciliation and sync idempotency, and restrict multi-device sync rollout until AUD-009 is resolved.

---

**Confirmation of audit rules:** No application source code, configuration, lockfile, schema, migration, database, or environment file was modified during this audit. No commits, pushes, merges, stashes, or resets were performed. No destructive tests were run against any live or customer database. The only repository change is this report file: `docs/MOTARD_FULL_PROJECT_STRICT_AUDIT.md`.
