# MOTARD ERP — Comprehensive Improvement Plan

> **Nature of this document:** a planning deliverable only. No project file, database, configuration, commit, or
> remote was modified to produce it. The disposable dev PostgreSQL (`.tmp-pgdata-dev`, DB `erp_test`) was started
> only to run the existing test suites and one read-only probe **from the scratchpad** (outside the repository),
> then stopped.
>
> **Inputs:** `PROJECT-IMPROVEMENT-PLAN.md` (1,201 lines, read in full; used as a reference, not as truth),
> `REPAIR-PLAN.md`, `divin-plean.md`, and — authoritative — the **current repository**: branch
> `clean-desktop-release`, HEAD `6383f7f5`, plus a working tree of **102 changed/untracked entries**
> (72 modified tracked files, 30 untracked), inspected on 2026-09-23.
>
> **Guiding rule (from the request):** preserve the project's existing business and accounting meaning exactly.
> A field is interpreted by how the code computes it, never by its name. Improvements change technical
> implementation, validation, performance, consistency, or safety — not business behaviour.

---

## 0. ملخص تنفيذي (Arabic executive summary)

**الوضع الحالي أسوأ مما تفترضه الخطة المرجعية:** شجرة العمل الحالية (غير المُلتزَمة) تحتوي تنفيذاً جزئياً لخطط
سابقة، لكنه **كسر أشياء كانت تعمل**:

1. **الخادم لا يُبنى أصلاً** — خطأ صياغة في `server.ts:522` (`rows[0()?.id`).
2. **إنشاء أي مرتجع (بيع أو شراء) معطّل تماماً** — `ReferenceError: saleTotal is not defined` (حُذفت ثلاثة تعريفات أثناء
   إعادة هيكلة أقفال اللفائف). مُثبت باختبار موجود يفشل الآن.
3. **تسديد أكثر من فاتورة دفعة واحدة يفشل دائماً** — مُعاد إنتاجه: كل السندات في الدفعة تحمل نفس
   `client_operation_id` فيصطدم الفهرس الفريد، والمسار صار يَفرض مفتاح Idempotency.
4. **التقارير صارت أسوأ**: استُبدل حد 1000 بحد **50** في 30+ موضعاً دون أي ترقيم صفحات؛ سبعة تقارير وشاشة العميل
   ونموذج السند تحسب الآن من أحدث 50 سجلاً فقط.
5. **تحميل العملاء يكرر أول 200 عميل حتى 50 مرة** (الواجهة ترسل `offset` والخادم يقبل `page` فقط).
6. **تغيير غير معتمد في دالة التقريب المالية `round2dp`** — لا يحل المشكلة المقصودة ويجعل التقريب يختلف حسب حجم المبلغ.
7. **حُذف `README.md` واستُبدل `docs/decisions.md` (441 سطراً من قرارات محاسبية ومعمارية) بـ45 سطراً.**
8. **وضع الأمان (SAFE_MODE) لا يمكن الخروج منه من الواجهة** (يمنع تسجيل الدخول نفسه)، و«قبول الأساس» لا يُحفظ.
9. **الاستعادة ما زالت تمسح بيانات الشركة قبل التحقق** (معاملة المسح منفصلة عن الإدخال).
10. **سطح المكتب يتصل بقاعدة البيانات كـ superuser** — كل عزل RLS معطّل فعلياً على سطح المكتب.

**قواعد المحاسبة الحالية محفوظة كما هي في هذه الخطة** (القسم 5): الخصم في الفاتورة وفي السطر **مبلغ ثابت** لا نسبة،
الضريبة والشحن **مبالغ ثابتة** تُضاف، الخصم الافتراضي و«ضريبة القيمة المضافة» في بطاقة الطرف **نِسَب للعرض فقط**
ولا تدخل أي حساب، إلخ. لم يُقترح تغيير أي معنى محاسبي؛ الحالات التي تبدو غريبة مذكورة كقرارات بشرية فقط.

**ترتيب العمل:** المرحلة −1 (إيقاف النزيف: استعادة البناء والصحة) → 0 (حماية البيانات) → 1 (الصحة المالية) →
2 (التزامن والمزامنة) → 3 (اكتمال البيانات والأداء) → 4 (التشغيل طويل الأمد). لا يُوزَّع أي مثبّت قبل اجتياز
بوابات المرحلتين −1 و0.

---

## 1. Current-State Evidence (reproduced on 2026-09-23)

| Check | Command | Result | Label |
|---|---|---|---|
| Backend type-check | `cd backend && npx tsc --noEmit -p .` | **FAIL** — `src/presentation/server.ts(522,44): error TS1005: ']' expected` | REPRODUCED |
| Backend type-check with `server.ts` excluded (scratch tsconfig) | `tsc -p <scratch>/tsconfig.probe.json` | **21 hidden errors**: 20 × `PostgresReturnRepository.ts` (`saleTotal`, `costTotal`, `isEntryReturn` undefined, lines 404-557) + 1 × `idempotency-handler.middleware.ts(21,35) TS1266` | REPRODUCED |
| Frontend type-check | `npx tsc --noEmit -p .` | **FAIL — 9 errors** (`"return"` invoice type removed incompletely: `invoice-scenarios.test.ts:45,318`, `PartyDetails.tsx:666,2083`, `invoices.index.tsx:41`, `invoices.tracking.tsx:103`; `useInventory.ts:83,86,89` `page` not in `InventoryFilter`) | REPRODUCED |
| Backend tests (live PG, migrations 1–84 applied) | `cd backend && npx vitest run` | **2 failed / 485 passed** (84 files): `customer-statement-reconcile` → `ReferenceError: saleTotal is not defined` at `PostgresReturnRepository.ts:404`; `sync-coverage` → integrity POST routes not registered | REPRODUCED |
| Frontend tests | `npx vitest run` | **1 failed / 215 passed**: `dfp029-credentials` — `README.md` no longer exists | REPRODUCED |
| Desktop compile | `cargo check` | PASS | REPRODUCED |
| Desktop tests | `cargo test` | **PASS — 62 passed, 0 failed** | REPRODUCED |
| Probe: settle 2 invoices with Idempotency-Key | scratch vitest (outside repo) calling `settleInvoicesUseCase` with `ctx.clientOperationId` | **FAIL** — «تعذّر حفظ السند بسبب تعارض في البيانات»; control without key **PASS** | REPRODUCED |
| Probe: drizzle `sql` with `ESCAPE '\'` | `PgDialect().sqlToQuery(...)` | generated SQL contains `ESCAPE ''` (escaping disabled) | REPRODUCED |

### 1.1 Reading the results

- The desktop Rust side compiles and its 62 unit tests pass, including the new boot-log and db-meta code.
- The TypeScript side is **not releasable**: the backend cannot be compiled, and a core financial flow (returns) and a
  core payment flow (multi-invoice settlement) fail at runtime.
- The passing backend count (485) hides these regressions because vitest transpiles without type-checking and no test
  exercises settlement with an Idempotency-Key. Stage −1 adds those tests.

### 1.2 What the working tree implemented (from earlier plans) — classification

| Area | Implemented in source | Status after audit |
|---|---|---|
| Boot log (`runtime/boot_log.rs`, events in `stack.rs`, env `MOTARD_BOOT_ID`) | yes | PARTIAL — wired; redaction/rotation not independently verified; not yet exercised by a packaged boot |
| Fail closed on missing pgdata (`db_meta.rs` +125 lines) | yes | PARTIAL — needs the metadata/manifest matrix tests (§6 W0) |
| Data-integrity manifest + SAFE_MODE | yes | **DEFECTIVE** — cannot be exited from UI (login blocked), baseline not persisted, fails open on error (W-11) |
| Pre-op snapshot (`integrity/snapshot.ts`, bundled `pg_dump.exe`/`pg_restore.exe`) | yes | PARTIAL — works only when `POSTGRES_BIN` set (it is, `stack.rs:1068`); condition depends on db-meta (W-16) |
| Schema fingerprint (`schemaFingerprint.ts`, `meta/schema-fingerprint.json`) | yes | PARTIAL — used only in the legacy-baseline branch, not verified after every migration; no CI regeneration |
| Backup: warnings → 500 + scheduler writing real ZIPs | yes | PARTIAL — scheduler runs without tenant context (works on desktop only because of superuser, W-18) |
| Restore: refuse warnings | yes | PARTIAL — wipe still committed separately; no snapshot; no count verification (W-12) |
| Idempotency required on financial routes + `client_operation_id` | yes | **DEFECTIVE** — breaks multi-voucher settlement (W-03); late retries get 409 instead of the original result |
| Atomic outbox claim + lease columns + run lock | yes | PARTIAL — token optional, no lost-lease detection, lock connection release (W-13) |
| Ordered roll locking (`rollLocking.ts`) | yes | **DEFECTIVE** in returns (W-02); invoice cancel not covered (W-14) |
| Returns index, manual-movement index | yes | OK (2 overlapping manual-movement indexes; `recomputeCashboxBalanceAsOf` still loads all movements into JS) |
| Dashboard per-currency cash | yes | OK in intent; scalar semantics decision still open |
| Report/search/by-ids server routes | partial | **DEFECTIVE** — only party balances moved; `ESCAPE ''`; cursor mismatch (W-09) |
| Removal of 1,000-row assumption | attempted | **REGRESSION** — replaced by 50 with no pagination (W-04), parties duplicated (W-05) |
| Precision validation 2dp (invoice/voucher schemas) | yes | OK (validation only, replay unaffected) |
| `round2dp` EPSILON change | yes | **UNAPPROVED semantic change, ineffective** (W-08) |
| Party `inactive` status schema | yes | OK |
| Sync bootstrap routes | stub (501) | NOT IMPLEMENTED (correctly disabled) |
| `docs/decisions.md` | overwritten | **DATA LOSS** — 441 → 45 lines (W-07) |
| `README.md` | deleted | **DATA LOSS** (W-07) |

---

## 2. Assessment of `PROJECT-IMPROVEMENT-PLAN.md` (the reference)

**Agreed and adopted:** the governing chain (financial invariants → atomicity → idempotency → auditability →
reconciliation → recovery → scalability → measurement); evidence labels (OBSERVED / REPRODUCED / MEASURED /
INFERRED / NOT PROVEN); "implemented ≠ complete"; the authority map (§4.2); the transaction-boundary inventory
(IMP-014); the reconciliation service (IMP-013); request fingerprinting for idempotency (IMP-009); staging-first
restore (IMP-005); release gates A–D; completion definition.

**Corrected or refined:**

| Reference claim | Finding |
|---|---|
| IMP-004: "`backupScheduler.ts` only writes a `.pending` marker" | **Outdated.** It now calls `runTenantFullBackup` and writes a ZIP (`backupScheduler.ts:1-80`). The real remaining defect is different: it runs outside any tenant context (W-18). |
| §2.0/§2.2: "working tree contains repair implementations that must be re-audited" | Correct, but understated: the tree currently **does not build** and **breaks returns and settlements** (§1). Re-audit is not enough — a stop-the-line stage is needed (§6). |
| IMP-022: "Parallelize only independent queries on safe pool connections" | Correct; the verified pool behaviour is: top-level `db` queries use separate pooled clients (RLS-safe), `tx` queries share one client (never parallelize); pool `max: 20` (`drizzle.ts:86`). |
| IMP-008: tenant consistency | Refined: on desktop the DB role **is the superuser** (`stack.rs:976-978` `DB_SUPERUSER`), so RLS does not enforce anything there. Tenant consistency on desktop relies entirely on application predicates (§11 S-1). |
| IMP-009: "universal durable idempotency" | Refined: the current implementation of durable ids is **wrong for one-to-many operations** (settlement creates N vouchers) — the operation id must live on an operation record, not on each document (W-03, IMP-009′). |
| IMP-020: "no hidden hard ceiling" | Confirmed as necessary — the tree now contains two hidden ceilings (`fetchAllPaged` 50×200 and `limit: 50` everywhere). |
| IMP-023: "Do not add indexes without EXPLAIN" | Kept as policy; note the returns and manual-movement indexes were added and are low-risk (small tables, verified missing in catalog). |
| Accounting meaning | The reference does not enumerate the actual meaning of money fields. §5 below does, from code. |

**Added (not in the reference):** stop-the-line stage (§6); business-rule register with evidence (§5);
superuser/RLS finding; restore wipe/insert split; `ESCAPE ''` bug; party offset bug; `round2dp` analysis;
documentation loss; SAFE_MODE exit deadlock; return-valuation questions.

---

## 3. Scope, Evidence Rules, Non-Goals

- Labels: **OBSERVED** (read in current source), **REPRODUCED** (demonstrated by a run), **MEASURED** (runtime
  metrics), **INFERRED** (follows from code), **NOT PROVEN**.
- Non-goals: changing any accounting, tax, discount, FX, COGS, return, settlement, cashbox, or stock meaning;
  deleting data; baselining migrations blindly; claiming exactly-once sync; adding infrastructure (queues, new DB,
  new ORM); rewriting working modules.
- Every repair item states: evidence, current behaviour, behaviour to preserve, exact change, files to change,
  files not to change, tests, acceptance criteria, rollback.

---

## 4. Architecture Truth Boundaries (adopted from the reference, completed)

| Concept | Authority (code) | Must never be recomputed by | Reconciliation |
|---|---|---|---|
| Line total | `lineTotal` = `max(0, round2dp(qty × price − discountAmount))` — `packages/shared/src/entities/Invoice.ts:40-45` | UI with a different formula | invoice/line audit |
| Invoice total | `round2dp(subtotal − discount + tax + shipping)` — same file `:53-58` | UI, reports | stored `total` vs recomputed |
| Invoice paid | `invoices.paid` maintained transactionally by voucher create/cancel (+ `credit_applied`) | reports summing vouchers | paid vs Σ applied voucher amounts + credit |
| Party balance | active `ledger_entries` Σ(debit−credit) customer / Σ(credit−debit) supplier, per currency — `PostgresStatementRepository.ts:76-81` | browser loops | statement vs report |
| Customer credit | `R − B` (open remainders − ledger balance) — `customerCredit.ts` | UI | credit audit |
| Stock | `rolls.remaining_kg/pieces` + `stock_movements` | reports | movement replay audit |
| Cashbox | `cashbox_daily_balances` / `recomputeCashboxBalanceAsOf` per currency | dashboard's own formula (fixed) | daily vs recompute |
| Profit | revenue = subtotal − discount (excludes tax & shipping), COGS from sale-time snapshot, expenses — `backend/src/domain/entities/Profit.ts` | UI | profit audit |
| Sync delivery | `(tenant_id, op_id)` unique + outbox/inbox state | UI | queue audit |
| Schema | migration journal + fingerprint | drizzle declarations | fingerprint diff |

---

## 5. Business-Rule Register — preserve exactly (evidence from code)

This register answers "what does each field mean in *this* system". It is binding for every repair below.

### 5.1 Invoice money fields

| Field | Meaning in this system | Evidence | Must NOT be reinterpreted as |
|---|---|---|---|
| `invoice_lines.discount_amount` (UI «الخصم» on each line) | **Fixed amount** in the invoice currency, subtracted from `qty × pricePerKg`; line total floored at 0 | `packages/shared/src/entities/Invoice.ts:40-45`; UI `SaleLineCard.tsx:256-259` (`FormattedAmountInput`) | a percentage |
| `invoices.discount` (header «الخصم») | **Fixed amount** subtracted from the subtotal; must be ≤ subtotal | `Invoice.ts:53-58`; schema `superRefine` "الخصم لا يمكن أن يتجاوز المجموع الفرعي"; UI `TotalInputCell` with currency suffix (`invoices.sale.new.tsx`) | a percentage |
| `invoices.tax` («الضريبة») | **Fixed amount added**, not a rate | `Invoice.ts:57`; UI currency-suffixed input | a VAT rate |
| `invoices.shipping` | **Fixed amount added** | same | — |
| `invoices.paid` | Cash applied at creation (capped at total for sales) + credit applied + later voucher applications, in the invoice currency | `PostgresInvoiceRepository.create`, `PostgresVoucherRepository.create/cancel` | Σ of raw voucher amounts |
| `invoices.credit_applied` | Part of `paid` funded from the customer's credit; no ledger movement | migration `20261001_customer_credit_application.sql` | a payment |
| `vouchers.applied_amount` | Part of a receipt that settled its linked invoice; excess = customer credit | same migration | — |
| `invoices.exchange_rate` | Frozen at creation: units of the currency per 1 USD; never revalued | `PostgresInvoiceRepository` BUG-03 comments; `fx.ts` | a live rate |

### 5.2 Party fields

| Field | Meaning | Evidence | Rule |
|---|---|---|---|
| `parties.default_discount` («خصم افتراضي») | A **percentage**, displayed with `%` | `PartyDetails.tsx:554` | **Display/metadata only — not applied to any invoice** (`rg defaultDiscount` finds no calculation). Do not wire it into invoices without an explicit business decision. |
| `parties.vat` («ضريبة القيمة المضافة») | A **percentage**, displayed with `%` | `PartyDetails.tsx:555` | Display only; invoice `tax` is an independent fixed amount. |
| `parties.status` | `active` / `inactive` (موقوف) / `cancelled` (via DELETE only) | `party.schema.ts` (current tree) | — |
| Settings `taxes[].rate` | A rate stored in settings | `useSettings.ts:156` | **Not applied to invoices** today. |

### 5.3 Vouchers, settlement, cash

| Rule | Evidence |
|---|---|
| Voucher `amount` = cash that moves; `discount` (مسامحة) is **added** to reduce the party balance; party settlement = amount + discount; cashbox moves by cash only | `voucher.schema.ts` comments; `PostgresVoucherRepository.create` "Contract: input.amount is CASH…" |
| Customer overpayment → invoice closed at its remaining; excess = customer credit; supplier overpayment refused | `PostgresVoucherRepository.create`, `splitOverpayment` |
| Multi-invoice settlement: one SET batch number, one voucher per allocated invoice; customer surplus → on-account receipt | `settleInvoicesUseCase.ts` |
| Cross-currency settlement uses the rate entered on the payment (`convertForSettlement`), exact closure when paying the remaining | `packages/shared/src/fx.ts` |
| Negative cashbox balance **allowed with a warning** | `cashboxBalanceHelper.ts` comment; UI warning in `VoucherForm.tsx` |
| Manual cash movements post two ledger legs with `cashImpact: none` (cash counted from `manual_movements`) | `PostgresCashboxRepository.ts:124-160` |

### 5.4 Returns

| Rule | Evidence | Status |
|---|---|---|
| Sale/purchase return must match the original invoice currency and reuse its **frozen rate** | `PostgresReturnRepository.ts:185-192` | preserve |
| Return value per roll = returned kg × **`AVG(invoice_lines.price_per_kg)`** (simple, unweighted average across the original invoice's lines of that roll), rounded to 2 dp | `PostgresReturnRepository.ts:193-209, 402-406` | **preserve**; see decision D-5 (unweighted average and ignored line/header discounts are unusual but must not be changed without approval) |
| Return value ignores the original line `discountAmount` and header `discount` | same | preserve; decision D-5 |
| Returns reduce the invoice remaining (`total − paid − active returns`) | voucher/settlement code | preserve |
| Dashboard "unpaid" counts only `kind='sale'` returns; profit debts count all active returns | `PostgresDashboardRepository.ts` unpaid query; `PostgresProfitRepository.getDebts` | preserve both; decision D-6 |

### 5.5 Profit and reports

| Rule | Evidence |
|---|---|
| Revenue = subtotal − discount (tax and shipping excluded) | `backend/src/domain/entities/Profit.ts:30` comment (P0-LOGIC-3.6d) |
| COGS journaled at sale time from the roll cost snapshot (`costPerKg`), never live price | `PostgresInvoiceRepository` COGS comments; `fx-cogs-replay-pin.test.ts` |
| Receivables/payables never subtracted from profit; per-currency, never blended | `Profit.ts` |
| Reports never blend currencies (per-currency maps) | `reports.$slug.tsx` BUG-06/C-9/C-10 comments |
| Top-fabrics dashboard window: **all-time** today | `PostgresDashboardRepository.ts:158-183` — decision D-7 before changing |

### 5.6 Rounding

| Rule | Evidence |
|---|---|
| `round2dp` at HEAD: `Math.round(n × 100) / 100` | `git show HEAD:packages/shared/src/precision.ts` |
| Money columns `numeric(14,2)`; PostgreSQL rounds decimal literals half away from zero | schemas |
| Line → subtotal → total rounding order as in `Invoice.ts:40-58` | shared |
| SYP amounts validated to 2 dp like other currencies (`is2dp`) | schemas |

---

## 6. STAGE −1 — Stop the line: restore buildability and correctness of the working tree

Nothing else may start until every W-item is closed and **Gate −1** (§13) is green. These are defects
**introduced by the current uncommitted work**, except where marked "pre-existing".

---

### W-00 — Freeze and split the working tree (process)

**Evidence:** 102 changed/untracked entries on `clean-desktop-release` (72 modified tracked files, 1,366 insertions /
961 deletions; 30 untracked files including 6 migrations, integrity modules, routes, scripts, plan documents).

**Action:**
1. Create a safety copy **before any fix**: `git stash create` is not enough for untracked files — create a branch
   `wip/2026-09-23-snapshot` and commit the whole tree there *as is* (including plan files), then continue on a new
   branch from it. Record the commit SHA in the plan's evidence log.
2. Split the work into reviewable commits by concern (docs, stage −1 fixes, data-safety, sync, reports, schema).
3. Never squash data-safety changes together with UI changes.

**Acceptance:** every later commit is reviewable in isolation; the snapshot branch exists.

---

### W-01 — Backend does not compile (`server.ts:522`)

**Status:** REPRODUCED (`tsc` TS1005). **Severity:** CRITICAL (no server build, no desktop bundle).

**Evidence:** `backend/src/presentation/server.ts:522` `const tenantId = tenantRes.rows[0()?.id;`

**Fix:** `const tenantId = tenantRes.rows[0]?.id;` — and move the whole integrity block (lines ~505-551) into a
named function `runBootIntegrityChecks(pool)` in `backend/src/infrastructure/integrity/bootIntegrity.ts` so it can
be unit-tested (see W-11 for its semantics).

**Test:** `npx tsc --noEmit -p backend` exits 0; add `backend/tests/boot-integrity.test.ts` calling the extracted
function on a seeded DB.

---

### W-02 — Every return creation crashes (`saleTotal` / `costTotal` / `isEntryReturn` deleted)

**Status:** REPRODUCED — existing test `customer-statement-reconcile.test.ts` fails with
`ReferenceError: saleTotal is not defined` at `PostgresReturnRepository.ts:404`; hidden `tsc` shows 20 errors in
the same file (lines 404-557). **Severity:** CRITICAL (sale and purchase returns unusable).

**Root cause:** the ordered-lock refactor removed three declarations (visible in `git diff`):
```ts
const isEntryReturn = input.kind === "entry";
let saleTotal = 0;
let costTotal = 0;
```

**Fix:** restore exactly these three lines at their original position (before the per-roll loop that accumulates
`saleTotal`/`costTotal`, i.e. before line 402 in the current file). No other change.

**Behaviour to preserve:** return valuation rule in §5.4 (AVG price per roll, frozen invoice rate).

**Tests:** existing `customer-statement-reconcile`, `invoice-*`, returns suites green; add a focused
`backend/tests/return-create-smoke.test.ts` (one sale return + one entry return, assert ledger legs balanced and
stock restored).

---

### W-03 — Multi-voucher settlement always fails when an Idempotency-Key is sent

**Status:** REPRODUCED (scratch probe: 2 invoices + key → «تعذّر حفظ السند بسبب تعارض في البيانات»; same without key → OK).
**Severity:** CRITICAL — the settlement route now **requires** the key (`statement.route.ts:120`
`idempotency("POST", { required: true })`), so every UI settlement of ≥ 2 invoices, and every overpaid settlement
(which adds an advance voucher), fails.

**Mechanism:** `idempotency-handler.middleware.ts:59-66` copies the key into `ctx.clientOperationId`;
`settleInvoicesUseCase` creates N vouchers with the same `ctx`; `PostgresVoucherRepository.ts:378` writes
`clientOperationId` on each; migration `20261007_client_operation_id.sql` has
`UNIQUE (tenant_id, client_operation_id)` on `vouchers` → the second insert violates it → the whole batch rolls back.

**Same class of defect elsewhere (check each):**
- invoice create with `paid > 0` also inserts a linked voucher — currently **not** stamped (OK), keep it that way;
- `ledger_entries` has a unique index on `client_operation_id` too — any future stamping of legs would break every
  posting (each operation writes several legs). The column must stay unused on ledger rows.

**Correct design (replaces the per-document unique column):**
1. New table `financial_operations(tenant_id, operation_id uuid, operation_type text, request_hash text,
   status text CHECK (status IN ('processing','succeeded','failed')), response jsonb, created_at, completed_at,
   PRIMARY KEY (tenant_id, operation_id))`.
2. The idempotency middleware (for `required` routes) inserts `processing` **inside the same transaction** as the
   business mutation (route handlers already use `withTenantTx` for settlement; invoices/vouchers use repository
   transactions — pass the operation id into the use case and let the repository insert the operation row in its
   own transaction). On success the row becomes `succeeded` with the response body; on a replay with the same
   key and the same `request_hash`, return the stored response; with a different hash → 422
   `IDEMPOTENCY_KEY_REUSED`.
3. Documents keep a **non-unique** `client_operation_id` for traceability (drop the six partial unique indexes in a
   new migration; keep the columns).
4. Retention: `financial_operations` kept ≥ 1 year (decision D-12), then swept.

**Interim hotfix (if the full design cannot ship immediately):** stop writing `ctx.clientOperationId` into
`vouchers` (and returns/expenses/manual movements) — keep the 5-minute HTTP cache only — and drop the unique
indexes. This restores settlements immediately without losing the existing HTTP-level protection.

**Tests:** `backend/tests/financial-idempotency.test.ts`: (a) settle 2 invoices with a key → OK, 2 vouchers;
(b) same key replayed after cache expiry → same response, no new vouchers; (c) same key + different body → 422;
(d) concurrent same key → one succeeds, one gets the stored response or 409 in-flight; (e) invoice create replay.

**Preserve:** settlement allocation rules (§5.3), SET batch numbering, sync enqueue per voucher.

---

### W-04 — `limit: 1000` replaced by `limit: 50` without pagination (regression)

**Status:** OBSERVED (diffs) — **Severity:** HIGH (reports and financial screens now wrong for tenants with > 50 records).

**All occurrences (current tree):**

| File:line | Effect now |
|---|---|
| `src/routes/reports.$slug.tsx:81,83,85,87,90` | 7 reports (sales, purchases, returns, expenses, ledger, top fabrics, top customers) aggregate only the newest 50 rows |
| `src/routes/reports.index.tsx:64` (`FULL = {limit:50}`) | report index figures from 50 rows |
| `src/routes/ledger.tsx:38` | ledger screen shows 50 rows, no paging |
| `src/routes/receipts.index.tsx:31,33`, `payments.index.tsx:31,33` | 50 vouchers; invoice labels joined from 50 invoices |
| `src/routes/returns.index.tsx:26` | 50 invoices for joins |
| `src/routes/invoices.tracking.tsx:161,164` | tracking computed from 50 returns/vouchers |
| `src/components/cashbox/VoucherTable.tsx:43` | 50 vouchers |
| `src/components/vouchers/VoucherForm.tsx:129,134` | **only the party's newest 50 invoices can be selected for payment**; remaining uses the newest 50 returns tenant-wide |
| `src/components/parties/PartyDetails.tsx:261,264,267,276,578,714,715,859,860,864,1635,1637,1642,1801,1803,1808,2059,2061` | customer/supplier tabs and KPIs from 50 documents |

**Immediate fix (restores previous behaviour while Phase 3 lands):** revert these call sites to their HEAD values
(`limit: 1000`). This is strictly better than 50 and was the tested state.

**Real fix (Phase 3, IMP-20/21):** server aggregates for reports; paginated lists with page controls; server-side
remaining for the voucher form; see §9.

**Test:** a frontend lint rule / unit test that fails when a `use*List({ limit: N })` result feeds a `reduce`
without `hasNext` handling (implement as a simple AST check script `scripts/check-list-aggregation.mjs` run in CI).

---

### W-05 — Party cache loads the same first page up to 50 times

**Status:** OBSERVED — **Severity:** HIGH for tenants with > 200 customers or suppliers.

**Mechanism:** `src/presentation/hooks/useParties.ts` calls
`fetchAllPaged((page, limit) => container.parties.list.execute({ kind, limit, offset: page * limit }))`.
`PartyApiService.list` forwards the filter as query params; the backend `listPartiesSchema`
(`packages/shared/src/schemas/party.schema.ts:43-49`) accepts `page`, not `offset` — Zod strips `offset` → every call
returns page 0 → `hasNext` stays true → loop runs to `maxPages = 50` (`src/lib/fetchAllPaged.ts`) → 50 copies of
the first 200 parties; parties 201+ never load.

**Fix:** pass `{ kind, limit, page }`. Also make `fetchAllPaged` (a) stop when a page repeats the first id of the
previous page (defensive), (b) **throw or surface a visible warning** when `maxPages` is reached (no silent ceiling).

**Test:** `src/lib/fetchAllPaged.test.ts` (page stop, repeat detection, ceiling warning); backend party list
`?page=1` returns the second page.

---

### W-06 — Frontend does not type-check (9 errors)

**Status:** REPRODUCED.

**Fix:**
- Remove the remaining `"return"` invoice-type branches consistently: `src/components/parties/PartyDetails.tsx:666,2083`,
  `src/routes/invoices.index.tsx:41`, `src/routes/invoices.tracking.tsx:103`, and update
  `src/application/__tests__/invoice-scenarios.test.ts:45,318` (these tests encode an invoice type the backend never
  accepts — replace with `sale`/`entry` scenarios or delete the return-as-invoice cases).
  *Business note:* returns are separate documents (`returns` table); no invoice of type `return` exists in the
  backend schema — removing the type changes no accounting meaning.
- Add `page?: number` to `InventoryFilter` (`src/domain/types/index.ts` or the inventory port) — the backend already
  accepts it.

**Test:** `npx tsc --noEmit -p .` exits 0.

---

### W-07 — Documentation loss: `docs/decisions.md` overwritten, `README.md` deleted

**Status:** OBSERVED — `git diff --numstat docs/decisions.md` = 32 added / 428 deleted; HEAD version 441 lines with
**D-001** (0013 guarded apply), **D-002** (C-4/C-5/C-7), **D-003** (supplier balance sign unification), **D-004**
(supplier opening-balance migration), **D-005** (Argon2id-only passwords), **ADR-DESKTOP-2026**; working tree 45
lines. `README.md` (122 lines at HEAD) deleted; `src/dfp029-credentials.test.ts` fails because of it.

**Fix:** `git checkout HEAD -- README.md docs/decisions.md`, then **append** the new sections (lock order, archive
tables, hub bootstrap, performance gates) at the end of `docs/decisions.md` as new numbered decisions (D-006…), never
replacing existing ones.

**Why this matters for accounting:** D-003 records *why* the supplier balance sign is what it is; losing it invites
someone to "fix" a correct sign convention later.

**Test:** frontend suite green (`dfp029`); a doc check in CI that `docs/decisions.md` still contains every
`## D-00x` heading present at HEAD.

---

### W-08 — Unapproved and ineffective change to `round2dp`

**Status:** OBSERVED + REPRODUCED (numeric probe). **Severity:** HIGH (touches every money calculation, FX closure,
cash rounding).

**Evidence:** `packages/shared/src/precision.ts` now adds `Number.EPSILON` before `Math.round`. `Number.EPSILON`
(2.2e-16) is below the float spacing for any value ≥ 2, so the change affects only values below 2:
`1.005 → 1.01` (was 1.00) but `10000.005 → 10000.00` (PostgreSQL stores the decimal literal as 10000.01). Rounding
now depends on magnitude, and the business decision required before any rounding change (reference §9 Q2) was never
taken.

**Fix:** revert `round2dp` to the HEAD implementation now. If a JS/PostgreSQL-consistent rounding is later approved
(decision D-2), implement it on the **decimal string** of the number (the shortest representation JavaScript prints,
which is also what the `pg` driver sends to PostgreSQL): split integer/fraction digits, round half away from zero at the
third fraction digit, and rebuild — never by adding a float epsilon. Gate it with the full FX suites
(`fx-exact-closure`, `voucher-exact-invoice-closure`, `cross-currency-settlement`, `customer-credit-advance`) and a
property test comparing it with PostgreSQL `round(x::numeric, 2)` for 10,000 random values across magnitudes
0.001 … 1e10.

Also: `normalizeMoney2dp` (same file) is **dead code** (no caller) — remove it or wire it deliberately (decision D-2).

---

### W-09 — Typeahead search: escaping disabled and cursor inconsistent

**Status:** REPRODUCED (drizzle renders `ESCAPE ''`). **Severity:** MEDIUM.

**Evidence:** `backend/src/presentation/routes/search.route.ts:52,78,94,114` use `ESCAPE '\'` inside a tagged
template; `\'` is cooked to `'`, producing `ESCAPE ''` which disables escaping, while `likeContains` escapes with
backslashes → terms containing `%`, `_`, `\` match wrongly. Cursor (`:55`) compares `(name, id)` but ordering (`:57`)
puts exact code matches first → a paginated walk can skip or repeat rows. Fabric search (`:79`) has no cursor at all.

**Fix:** write `ESCAPE '\\'` (JS) or use drizzle `ilike()` (PostgreSQL's default LIKE escape is backslash, as used by
`PostgresInvoiceRepository.list`); make the cursor include the rank: `(rank, name, id) > (...)`, or return the exact
match as a separate first element outside the paginated list.

**Tests:** `backend/tests/master-typeahead.test.ts`: term `"10%"`, `"A_1"`, `"x\\y"`; cursor walk over 1,200 rows
without duplicates/gaps.

---

### W-10 — Test and type hygiene

- `idempotency-handler.middleware.ts:21` TS1266 (optional after rest) — replace the variadic signature with
  `idempotency(methods: string | string[], options?: { required?: boolean })` and update the call sites.
- `sync-coverage.test.ts` fails: add `POST /integrity/accept-baseline` and `POST /integrity/authorize-reset` as
  `exempt: "device-local integrity control, not a business document"` in `syncCoverage.ts`.

---

### W-11 — SAFE_MODE: cannot be exited from the UI; baseline acceptance not persisted; fails open

**Status:** OBSERVED. **Severity:** HIGH (a false positive locks the customer out; a true positive can be silently skipped).

**Evidence:**
- `dataSafeMode.middleware.ts` blocks every non-GET except `/api/integrity`; **`POST /api/auth/login` and
  `/api/auth/pin-login` are blocked**, but every integrity route requires `auth` (`integrity.route.ts:13,25,43`) →
  no token can be obtained → deadlock.
- `accept-baseline` only clears the in-memory flag (`dataIntegrityManifest.ts:164-169`) and writes
  `lastBootDecision`, **not** `lastKnownCounts` → the next boot detects the same drop again.
- `server.ts:505-551` wraps verification in `try { … } catch { logger.warn("data integrity verification skipped") }` →
  any error (e.g. manifest unreadable, count query failure) silently skips the safety gate.
- `readManifest()` returning `null` for a **corrupt** file is treated as "first install" (`verifyDataAgainstManifest`
  returns early).
- Manifest identity (`installationId`, `tenantId`) is not validated before trusting its counts.

**Fix:**
1. Allow-list in SAFE_MODE: `POST /api/auth/login`, `/api/auth/pin-login`, `/api/auth/refresh`, `/api/auth/logout`,
   `/api/integrity/*`. Everything else stays blocked.
2. `accept-baseline`: re-collect counts and write them as `lastKnownCounts` + `lastVerifiedAt`, require the admin's
   password in the request body (verify with `passwordHasher`), write an audit log row, and emit boot-log event
   `BASELINE_ACCEPTED` with the operator id.
3. Replace fail-open with fail-closed: an exception during verification → SAFE_MODE with reason
   `INTEGRITY_CHECK_FAILED`.
4. Distinguish "no manifest" (first install, no `db-meta.json` either) from "unreadable manifest" (→ SAFE_MODE
   `MANIFEST_UNREADABLE`; the mirror copy `logs/data-integrity.last.json` is tried first).
5. Validate `installationId` against `db-meta.json` and `tenantId` against the effective tenant before comparing.

**Tests:** `data-integrity-manifest.test.ts` extended: login works in SAFE_MODE; accept-baseline persists and the next
boot is clean; injected count-query error → SAFE_MODE; corrupt manifest → SAFE_MODE; mismatched installationId →
SAFE_MODE.

---

### W-12 — Restore still wipes before it can verify

**Status:** OBSERVED — `backend/scripts/restore-from-backup.mjs:264-280` deletes all tenant rows in one committed
transaction; inserts run in **separate per-table transactions** (`:306-331`); a failure calls `process.exit(1)` after
the wipe is already committed. Warnings are now refused (`:146-153`, good) but there is no pre-restore snapshot,
no `metadata.json` count/sha verification, and `ON CONFLICT DO NOTHING` skips are only warned about.

**Fix:** implement the reference IMP-005 protocol concretely:
1. Verify `metadata.json` sha256 of `database.json`, schema journal index, tenant id — before connecting.
2. Take a `pg_dump` snapshot (reuse `integrity/snapshot.ts`) and refuse if it fails.
3. Restore into a **staging database** created from the same migrations (`ensure-test-db` logic with a unique name),
   verify per-table counts == `metadata.rowCounts` and zero skipped rows, run the reconciliation audit (§8 IMP-13).
4. Apply to the target in **one transaction** (wipe + inserts + sequence advance + trigger re-create), verify counts
   again before `COMMIT`.
5. Write `restoreInProgress = { operationId, expectedCounts }` into the manifest so the next boot verifies against it.

**Tests:** `backend/tests/backup-restore-safety.test.ts`: valid backup; warnings → refused; checksum mismatch →
refused; injected insert failure mid-way → target unchanged; skipped row → refused; cross-hub cursor clamp preserved
(existing `restore-sync-state.test.ts` green).

---

### W-13 — Sync lease tokens are optional and a lost lease is invisible

**Status:** OBSERVED — `PostgresSyncOutboxRepository.ts:148-205`: `markSynced/markRejected/resetToPending` add the
token condition **only if** a token is passed, never check `status = 'pushing'`, and return `void`; the caller
(`syncUseCases.ts:396-406`) always runs `rollbackRejectedUnitLocally` after `markRejected` even if the lease was
lost. `claimBatch` reclaims legacy `pushing` rows with `lease_until IS NULL` immediately. No lease renewal, no
dead-letter view. Run lock: `sync.route.ts:676` `lockClient.release()` returns the client to the pool even if
`pg_advisory_unlock` failed → the session lock stays held by a pooled connection.

**Fix:**
1. Make the token **required** in the signatures; `WHERE id AND tenant_id AND status='pushing' AND lease_token = $t`;
   return `rowCount`.
2. In `runLocalSyncPush`, on `rowCount = 0` → log `LEASE_LOST {opId}` and skip all side effects (no rollback, no
   counters).
3. Lease renewal every 60 s for in-flight rows, token-guarded.
4. `release(true)` (destroy) when unlock throws or returns false.
5. Legacy `pushing` rows without `lease_until`: treat as expired only when `updated_at < now() - 5 min` (the old rule),
   not immediately.

**Tests:** `backend/tests/sync-lease-token.test.ts` (stale token cannot finalize; lost lease skips rollback;
renewal; unlock failure destroys client); `sync-claim-atomic.test.ts` (disjoint concurrent claims).

---

### W-14 — Lock ordering incomplete; helper side-effects

**Status:** OBSERVED — invoice cancel still locks rolls per line in line order (`PostgresInvoiceRepository.ts:1279`
sale restore, `:1328` entry reversal). `rollLocking.ts` uses `INNER JOIN colors` → a roll whose color row is missing is
reported as "roll not found". Invoice update's missing-roll message changed from «اللفافة المحددة غير موجودة» to the
create message.

**Fix:** use `lockRollsOrdered` in both cancel branches (collect `rollId`s from `ilines`, lock once, iterate the map);
use `LEFT JOIN colors` and validate color separately with the **original** message; restore the update-path message.

**Tests:** opposite-order create vs cancel × 50 iterations without SQLSTATE 40P01; messages unchanged (snapshot test
of error texts).

---

### W-15 — Duplicate / redundant indexes added

**Status:** OBSERVED — `20261003_manual_movements_indexes.sql` creates both `(tenant_id, date, currency)` and
`(tenant_id, currency, date)`; `20261006_idempotency_keys_expires_idx.sql` duplicates the existing `expires_at` btree
(catalog before the change already had `idempotency_keys btree (expires_at)`); `uq_ledger_entries_tenant_client_op`
is unused and dangerous (W-03).

**Fix:** new migration dropping the redundant ones after `EXPLAIN` confirms the kept index is used
(`recomputeCashboxBalanceAsOf` filters by `currency` then date range → keep `(tenant_id, currency, date)`).

---

### W-16 — Snapshot trigger depends on `db-meta.json`

**Status:** OBSERVED — `runDesktopMigrations.ts:195` snapshots when `journalIdx > currentIdx`, where `currentIdx` is
read from `DESKTOP_DB_META_PATH`; if the file is missing/unreadable, `currentIdx = 0` → a full `pg_dump` on **every**
boot (slow boots, disk growth), and if `pg_dump` fails the app refuses to start.

**Fix:** read the applied migration count from `drizzle.__drizzle_migrations` (authoritative) and compare with the
journal; snapshot only when pending migrations exist.

---

### W-17 — Integrity boot check reads `tenants` by slug only

**Status:** OBSERVED — `server.ts:519-522` uses `slug='default'` — correct for desktop, but the block runs on every
deployment. On the hub there is no `default` tenant → silently skipped. Make it desktop-only explicitly and add the hub
variant (`BOOTSTRAP_TENANT_ID ?? findAnyCompleted()`).

---

### W-18 — Automatic backup runs without tenant context

**Status:** OBSERVED — `backupScheduler.ts` → `runTenantFullBackup` (`backup.route.ts:307-350`) executes raw
`SELECT … WHERE tenant_id = …` via `db` **outside** any `runWithTenantContext`. It returns data on desktop only because
the desktop connects as the PostgreSQL superuser (§11 S-1), which bypasses RLS. Under a non-superuser role FORCE RLS
would return **zero rows without error** → an "OK" empty backup.

**Fix:** wrap the dump in `runWithTenantContext({ tenantId }, …)`; after the dump, compare row counts with the
integrity manifest and refuse (`BACKUP_SUSPICIOUS_EMPTY`) if business tables are empty while the manifest says
otherwise.

---

## 7. PHASE 0 — Customer data protection (build on what exists, close the gaps)

Phase 0 targets the desktop data lifecycle. The working tree already contains most building blocks (§1.2); each
item below states what exists and what is still required.

### IMP-01 Durable boot-decision log — PARTIAL
Exists: `runtime/boot_log.rs`, events `REUSE / FRESH_TEMPLATE / FRESH_INITDB / FACTORY_RESET / SNAPSHOT_FAILED`
(`stack.rs:316-513`), `MOTARD_BOOT_ID` (`stack.rs:1059`), 62 Rust tests pass.
Required:
1. Verify rotation by size and secret redaction with explicit tests (key allow-list; no DB password, JWT, DPAPI data).
2. Backend emits `MIGRATION_STARTED/OK/FAILED`, `TENANT_SELECTED`, `DATA_SAFE_MODE`, `BASELINE_ACCEPTED`,
   `SNAPSHOT_CREATED` to the same `boot.log` (append through a small file appender with the same JSON schema) — not
   only to pino.
3. `server.log` rotation before truncation (verify it exists in the current `stack.rs`; it was part of the design).
**Acceptance:** fresh, reuse, missing-pgdata, migration-failure and reset boots each leave a complete event sequence.

### IMP-02 Fail closed when prior data disappears — PARTIAL
Exists: `db_meta.rs` (+125 lines). Required: the full combination matrix as Rust tests —
{pgdata present/absent} × {db-meta present/absent/corrupt} × {manifest present/absent/corrupt} × {resetAuthorized
true/false} × {secrets.dat present/absent} — with the expected decision for each (table in the test file).
**Acceptance:** no combination with evidence of a prior installation reaches `FRESH_TEMPLATE`.

### IMP-03 Data-integrity manifest and SAFE_MODE — DEFECTIVE → see W-11, then:
- Extend counts with `stock_movements`, `audit_logs`, `sync_inbox`, `sync_tombstones`, `sync_conflicts`,
  `document_sequences` (count of rows), and the schema fingerprint hash.
- Record `lastSuccessfulBackupId` + checksum.
- Refresh the manifest periodically (every 30 min, desktop) — today it refreshes only at boot, so a crash after a day
  of work compares against morning counts (harmless for drops, but the baseline is stale).
- UI (`src/components/integrity/*`) must show the comparison table, last backup, boot-log path, and the three actions.

### IMP-04 Pre-operation snapshots — PARTIAL (W-16)
Exists: `integrity/snapshot.ts` (`pg_dump -Fc`, sha256, read-only chmod, retention 30 days), bundled binaries.
Required: snapshot also before factory reset (Rust folder copy — verify `stack.rs:316` path), before restore (W-12),
before legacy repair; free-space check (≥ 2 × DB size); never delete the newest verified snapshot; a `pg_restore --list`
verification after each dump.

### IMP-05 Backup/restore — PARTIAL (W-12, W-18)
Plus: include `metadata.json` in HTTP backups too (today only the scheduler path writes it); verify attachments/uploads
presence; backup retention (7 daily / 4 weekly / 12 monthly — decision D-11); optional off-device copy.

### IMP-06 Schema fingerprint — PARTIAL
Exists: `schemaFingerprint.ts`, committed `meta/schema-fingerprint.json`, used only on the legacy-baseline path.
Required: (a) verify after **every** migration on desktop (mismatch → `SCHEMA_UNVERIFIED` refusal with snapshot);
(b) CI step regenerating the fingerprint from a fresh migration run and failing on diff; (c) include RLS forced flags,
policies, triggers, functions, extensions; (d) hub runs it in report-only mode.

### IMP-07 Blind baseline removed — DONE in code, NOT PROVEN
Test matrix: legacy partial schema → refused + snapshot; complete schema without history → baselined; normal history →
unchanged; corrupt history → refused.

### IMP-08 Tenant/installation identity gate — PARTIAL (W-17) + S-1
Also: frontend reconciles `erp.install.tenantId` with the JWT tenant after login; module caches keyed by tenant and
cleared on logout/tenant change (IMP-26).

---

## 8. PHASE 1 — Financial correctness and auditability

### IMP-09′ Durable financial operation identity — redesign (replaces the current per-document unique column)
See W-03 for the design (`financial_operations` table, request hash, stored response, replay semantics). Apply to:
`POST /invoices`, `PUT /invoices/:id`, `POST /receipts`, `POST /payments`, `POST /returns`, `POST /expenses`,
`POST /cashbox/manual-movements`, `POST /cashbox/opening`, `POST …/statement/settle-invoices`, `POST …/statement/settle`,
`POST /ledger`. Sync materialization keeps its own `(tenant_id, op_id)` guarantee — do not route it through HTTP
idempotency.

### IMP-10 Money normalization — validation DONE; policy OPEN
Keep the 2-dp validation already added to invoice/voucher schemas (it only rejects new inputs; replay is unaffected
because materialization does not use Zod — verified). Before any further change:
1. Run `backend/scripts/audit-precision.mjs` (exists, untracked) on a copy of real data and on the hub; record results.
2. Decision D-2 (rounding convention). Until then `round2dp` stays as at HEAD (W-08).
3. Post-persistence invariant test using the **exact** domain formula (§4): `total = round2dp(subtotal − discount + tax + shipping)`
   with `subtotal = round2dp(Σ lineTotal)` and `lineTotal = max(0, round2dp(qty×price − discountAmount))`.
   Historical rows may differ by ≤ 0.01; the test applies to new writes only.

### IMP-11 Ledger integrity — correct invariant (correction to the reference)
The reference (IMP-013) proposes "ledger debits = credits by batch/currency". **In this system that is false for
cross-currency documents by design:** a USD voucher settling an SYP invoice posts the party leg in SYP, the cash leg in
USD and an `fx_gain`/`fx_loss` leg in USD base (`PostgresVoucherRepository.create`, "FX-LEG FIX"). The correct
invariants are:
- per `reference_id`: **Σ base_debit = Σ base_credit** (USD base) — for all documents;
- per `reference_id` **and** currency: Σ debit = Σ credit — **only** when the document is single-currency;
- every party leg of an invoice has the invoice's currency;
- cancelled references: every leg of the reference is cancelled together.
Implement these checks in the reconciliation service (IMP-13); do not add a DB constraint that would reject valid
cross-currency postings.

### IMP-12 Correction/deletion policy — OPEN
Inventory: invoices/vouchers/returns are cancelled (append-only ledger trigger `trg_ledger_entries_append_only`);
manual cash movements are **deleted** (`PostgresCashboxRepository.deleteManualMovement`, cancelling their ledger legs).
Decision D-10: keep delete (with audit row) or convert to void. No change before the decision.

### IMP-13 Read-only reconciliation service — NEW
`backend/scripts/reconcile.mjs` + `GET /api/integrity/reconcile` (admin, read-only), output JSON/CSV with tenant,
currency, entity id, expected, actual, source rows. Checks (all derived from §4/§5 rules, no new rules):
1. invoice `total` = domain formula from stored components and lines (tolerance 0.01 for legacy rows, flagged separately);
2. invoice `paid` = at-create applied cash (`vouchers.applied_amount` of the linked RCP/PAY voucher, or legacy party leg)
   + Σ later active vouchers' applied amounts + `credit_applied`;
3. ledger invariants of IMP-11;
4. statement final balance = Σ active party legs (per party, currency);
5. customer credit `R − B ≥ −(non-invoice debt)`; flag negative unattached credit where `credit_applied > 0`;
6. stock: `rolls.remaining_kg` = initial ± Σ stock_movements (within the documented exceptions);
7. cashbox: `cashbox_daily_balances` = `recomputeCashboxBalanceAsOf` per currency and day;
8. returns: returned kg per roll ≤ sold kg of the original invoice;
9. sync: every `applied` inbox op has its business row; no pending outbox for a cancelled local document without a cancel unit.
Never auto-corrects.

---

## 9. PHASE 2 — Transactions, locks, sync

### IMP-14 Transaction-boundary inventory — NEW (adopted from the reference)
Produce `docs/transaction-inventory.md`: for each mutating route — transaction owner, rows locked (in order), rows
written, outbox enqueue inside/outside the transaction, external calls (none allowed while locks are held), idempotency,
rollback test. Known item to verify: `settle-invoices` enqueues sync units inside `withTenantTx` (good); hub pairing
calls remote HTTP outside business transactions (good).

### IMP-15 Global lock order — PARTIAL (W-14)
Documented order (to be restored into `docs/decisions.md` as D-006): cashbox advisory lock → invoice row(s) by id →
party → rolls by id (`lockRollsOrdered`) → number blocks → inserts. Apply to cancel paths; add the deadlock test.

### IMP-16/17 Atomic claim, lease tokens, run exclusion — PARTIAL (W-13)
Pull cursor: `setPullCursor` is an upsert without monotonic guard — add `WHERE sync_state.last_pull_seq IS NULL OR
EXCLUDED.last_pull_seq >= sync_state.last_pull_seq` (never move the cursor backwards except via the explicit
`resetPullCursor`).

### IMP-18 Dead letters and financial reconciliation — NEW
`GET /sync/dead` (admin) listing hub-dead and locally-dead units with entity links; financial dead units: manual
resolution only (decision D-9); masters: retry with a new op id. Surface counts in Settings → المزامنة السحابية.

### IMP-19 Retention and hub bootstrap — PARTIAL
Device retention job exists (`integrity/retentionJobs.ts`: deletes `synced` outbox rows older than N days; deletes
expired idempotency keys). Required: batched deletes (`LIMIT 1000` per statement), dry-run mode, metrics.
Hub compaction stays disabled (`syncBootstrap.route.ts` returns 501 — correct) until the snapshot/bootstrap design is
implemented and tested (reference IMP-019).

---

## 10. PHASE 3 — Data completeness and read performance

### IMP-20 Remove every "one page = all" assumption — REGRESSED (W-04, W-05)
After the W-04 revert, implement per class:
- **Pickers:** switch `PartyCombobox` and roll/fabric/color pickers to the search endpoints (after W-09 fix) with
  250 ms debounce and abort (IMP-26); by-id endpoints for historical documents; bounded LRU cache (≤ 500 entries,
  tenant-keyed). Remove `fetchAllPaged` from `useParties`/`useInventory` once pickers no longer need full arrays.
- **Reports:** one server endpoint per report computing the **same formulas** as today's React components (§5.5):
  sales/purchases (`invoiceTotal`, paid from `invoices.paid`), returns (return lines value as stored), expenses,
  ledger (active entries), cash (manual movements), top fabrics (line net `max(0, qty×price − discountAmount)` grouped
  by fabric and currency — identical to the dashboard's `lineNet`), top customers. Parity test per report on a fixture:
  old JS function vs endpoint → identical rows.
- **Lists:** real pagination with page controls for ledger, receipts, payments, returns, vouchers.
- **Voucher form:** server-provided `remaining` per open invoice of the party (total − paid − active returns), with
  paging/search for the invoice selector.
- **Party details:** paginated tabs; KPIs from party stats (`computeListStats`) and the statement endpoint.

### IMP-21 Party balances — PARTIAL
`/reports/party-balances` exists (`reports.route.ts`). Required: validate `kind` ∈ {customer, supplier}; replace the two
correlated `total`/`paid` subqueries with one grouped join; decide whether parties with no activity appear (old UI
showed only parties with invoices — preserve: filter `count > 0`); equivalence matrix test vs statement (customers
and suppliers × SYP/USD/EUR × receipts, payments, returns, discounts, cancellations, opening balances, overpayment
credit, cross-currency FX).

### IMP-22 Dashboard — PARTIAL
Per-currency cash done. Remaining: KPI contract document; merge the three sales windows into one `FILTER` query;
concurrency ≤ 4 on pool connections (never inside `tx`); top-N in SQL keeping the all-time window (decision D-7);
`recomputeCashboxBalanceAsOf` manual movements aggregated in SQL (still loads all rows — `cashboxBalanceHelper.ts`).

### IMP-23 Index program — PARTIAL (W-15)
Evidence-driven only (EXPLAIN on the §12 datasets). Reconcile drizzle vs catalog (`idx_invoices_party_date` declared,
not created).

### IMP-24 Search correctness — PARTIAL (W-09)

### IMP-25 Invoice update query reduction — PARTIAL
Update path uses `lockRollsOrdered` (one query); stock movements still per row — batch only if `recordStockMovement`
semantics (balanceAfterKg) allow.

### IMP-26 Abort signals and cache authority — OPEN
32 `void signal` sites in 14 hooks; add signal plumbing for reads only; tenant in every cache key; clear module caches
on logout/tenant switch.

---

## 11. Security and Isolation Findings

| ID | Finding | Evidence | Plan |
|---|---|---|---|
| S-1 | **Desktop connects to PostgreSQL as the superuser** → RLS/FORCE RLS are bypassed on desktop; tenant isolation on desktop relies only on `WHERE tenant_id` predicates | `stack.rs:976-978` (`DB_SUPERUSER`) | Create an application role (`motard_app`, NOSUPERUSER, NOBYPASSRLS, owner of nothing) during provisioning; run the backend with it; keep the superuser only for migrations/snapshots. Test: a query without tenant context returns 0 rows on desktop. Decision D-13 (risk accepted vs fixed), because single-tenant installs make the risk low but backups/scripts depend on the bypass today (W-18). |
| S-2 | SAFE_MODE blocks authentication (W-11) | — | fixed by W-11 allow-list |
| S-3 | `/integrity/accept-baseline` and `authorize-reset` rely on JWT role only | `integrity.route.ts:25-50` | require password re-entry + audit row |
| S-4 | Logs must never contain secrets | boot log, pino | redaction tests (IMP-01) |
| S-5 | Backups unencrypted on disk | backup scheduler | decision D-11 (encrypt with a key from the DPAPI store) |
| S-6 | Search/typeahead endpoints are `readGuard` for all roles | `server.ts` registration | acceptable (same as lists); keep tenant predicate + RLS |

---

## 12. Testing and Measurement Blueprint

### 12.1 Stage −1 regression tests (must be added first)
`return-create-smoke`, `financial-idempotency` (incl. multi-voucher settlement with key), `fetchAllPaged` unit,
`master-typeahead` (escape + cursor), `sync-lease-token`, `boot-integrity` (SAFE_MODE allow-list, fail-closed),
`backup-restore-safety`, lock-order deadlock test incl. cancel, doc-heading check, `tsc` on both projects in CI.

### 12.2 CI gates (none exist for type-checking today — the regressions passed because vitest does not type-check)
```
npx tsc --noEmit -p backend        # must pass
npx tsc --noEmit -p .              # must pass
cd backend && npx vitest run       # with DB
npx vitest run
cd desktop/src-tauri && cargo test
node backend/scripts/schema-fingerprint.mjs --check
```

### 12.3 Financial, concurrency, upgrade, scale matrices
Adopt the reference §6.1–6.5 as written, with these corrections: ledger balance checked in base currency (IMP-11);
settlement tests must always send an Idempotency-Key (the production path); scale datasets must include multi-line
invoices with line discounts and header discounts as **fixed amounts** (§5.1) so that report parity tests exercise the
real formulas.

### 12.4 Performance gates
Structure from the reference §7 Gate C; numeric thresholds are **proposals** until decision D-14; the harness scripts
in the tree (`perf-harness.mjs`) must be checked for placeholder output before use (reference IMP-004 note) and must
record git SHA, dirty state, dataset seed, PostgreSQL version and pool size with every run.

---

## 13. Release Gates

- **Gate −1 (build & correctness restored):** both `tsc` pass; all backend (with DB), frontend and Rust tests pass;
  W-01…W-18 closed with tests; `README.md` and `docs/decisions.md` restored; working tree split into reviewed commits.
- **Gate A (data safety):** reference Gate A + IMP-02 combination matrix + SAFE_MODE exit path proven + restore
  staging-first proven + upgrade matrix (reference §6.3 / REPAIR-030 scenarios) on a packaged build.
- **Gate B (financial & sync correctness):** IMP-09′, IMP-11/13 reconciliation clean on seeded and real-copy data,
  lease/lock tests, no duplicate financial effect under concurrency.
- **Gate C (read correctness & performance):** no one-page-as-all consumer; report parity; party balances equivalence
  matrix; agreed performance thresholds met at the declared tier.
- **Gate D (long-term operations):** backup schedule + monthly restore drill; retention jobs with dry-run; hub
  bootstrap design implemented before any hub compaction; runbooks and alerts.

---

## 14. Implementation Order

1. **W-00** freeze & split. 2. **W-07** restore documents. 3. **W-01, W-02, W-06, W-10** (build + returns).
4. **W-03** (hotfix: stop stamping documents + drop unique indexes). 5. **W-04, W-05** (revert 50 → 1000; fix offset).
6. **W-08** revert `round2dp`. 7. **W-09, W-11, W-13, W-14, W-15, W-16, W-17, W-18, W-12**. → **Gate −1**.
8. Phase 0: IMP-01…IMP-08 completion → **Gate A** (with packaged upgrade matrix).
9. Phase 1: IMP-09′ (financial_operations), IMP-13 reconciliation, IMP-10 policy after D-2, IMP-11, IMP-12 after D-10.
10. Phase 2: IMP-14 inventory, IMP-15…IMP-19 → **Gate B**.
11. Phase 3: IMP-20/21 (pickers, reports, lists, voucher form, party details), IMP-22…IMP-26, with baseline and
    after measurements → **Gate C**.
12. Phase 4: retention, backup drills, hub bootstrap design, archive decision, observability → **Gate D**.

---

## 15. Decisions Required (owner, date, rationale must be recorded in `docs/decisions.md`)

| # | Decision | Why it matters | Recommendation |
|---|---|---|---|
| D-1 | Confirm negative cashbox balance is allowed with warning for every cash operation and currency | reference Q1; current code allows it | confirm as-is |
| D-2 | Official rounding convention and whether JS must match PostgreSQL exactly | W-08; FX closure | keep HEAD `round2dp` until a decimal-string implementation is approved and tested |
| D-3 | May an inactive (موقوف) party be selected in new documents? | picker filtering | not selectable; visible in history |
| D-4 | No-session dashboard cash: map + `null` scalar? | current tree returns `null` + map | confirm |
| D-5 | **Return valuation:** keep the unweighted `AVG(price_per_kg)` per roll and ignore line/header discounts? | an invoice with two lines of the same roll at different prices, or with discounts, credits a return differently from what was charged | **no change without explicit accounting approval**; if changed, it is a business-rule change requiring migration of nothing but a documented cut-over date |
| D-6 | Dashboard unpaid (`kind='sale'` returns only) vs profit debts (all returns) — intentional? | numbers shown to users differ | keep both; document |
| D-7 | Top-fabrics window (all-time today) | performance vs meaning | keep all-time until decided |
| D-8 | Party `default_discount` / `vat` are percentages that are **not** applied — should they ever be? | fields look functional but are display-only | keep display-only |
| D-9 | Dead-letter policy for financial sync units | IMP-18 | manual resolution only |
| D-10 | Manual cash movement delete vs void | append-only audit policy | void + audit (recommendation), not implemented before approval |
| D-11 | Backup schedule, retention, encryption, off-device target, RPO/RTO | IMP-05 | daily; 7/4/12; encrypted; user-selected second folder; RPO 24 h |
| D-12 | Retention of `financial_operations` (idempotency evidence) | IMP-09′ | ≥ 1 year |
| D-13 | Desktop DB role: keep superuser or introduce an RLS-bound app role | S-1 | introduce app role in a later release after W-18 |
| D-14 | Performance thresholds and supported data tier | Gate C | agree before Phase 3 |
| D-15 | Supported oldest upgrade source and legacy-cluster path | Gate A | current release − 2; legacy via support tool |
| D-16 | Is the uncommitted working tree an intended branch? | W-00 | snapshot branch, then split |

---

## 16. Completion Definition (adopted from the reference, with one addition)

A workstream is **COMPLETE — verified** only with: implementation; migration if needed; unit + integration tests;
concurrency/recovery tests where relevant; **both type-checks passing**; measurements where relevant; backup/upgrade
evidence where relevant; runbook; reviewed diff. Otherwise it is **PARTIAL** or **NOT PROVEN**. A green vitest run is
not sufficient evidence on its own (this audit found two runtime-breaking defects behind a 485-test green count).

---

## 17. Final Assessment

- **Accounting core:** sound and preserved — fixed-amount discounts, fixed tax/shipping, frozen FX, sale-time COGS,
  per-currency statements, overpayment-to-credit, append-only ledger. This plan changes none of it.
- **Current working tree:** **not releasable** — the backend does not compile, returns and multi-invoice settlements
  fail, reports became less complete, and documentation was lost. Stage −1 exists to fix exactly this, quickly and
  with regression tests.
- **After Gate −1 and Gate A:** pilot-ready on the data-safety axis.
- **After Gates B and C:** production-ready only for the measured tier.
- **Ten-year readiness:** not proven until backup drills, upgrade matrices across releases, retention, and hub
  bootstrap/compaction are operating (Gate D).
