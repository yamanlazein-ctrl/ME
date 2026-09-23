# MOTARD ERP — Engineering Philosophy for a Ten-Year Financial System

## A note on sources, stated upfront

I do not have access to the source code of "Al-Amin" or "Amwal" (two long-established accounting products). Everything said about their internals below is general industry knowledge, not direct proof — treat it as **NOT PROVEN** in the strict sense. What follows is a set of engineering principles that are independent of any specific product name, and that any accounting software must follow to survive for decades. These are then applied directly to MOTARD.

Where public documentation is referenced (e.g. that Al-Amin stores company data in SQL Server and documents integrity-audit tooling, or that Amwal distributes with SQL Server and documents automatic posting and archived backups), that is cited as publicly stated information about those products — not as confirmed knowledge of their internal design.

---

## Part 1 — The Seven Principles Behind Software That Lasts Decades

The secret is not "the framework." It is these seven principles, and they are independent of the product name.

### 1. Strict double-entry as the single source of truth
Every financial movement is written as two balanced sides (Σ debits = Σ credits). The balance is never stored as a directly-editable number — it is **derived** from the entries. This is why "not a single unit goes missing": any imbalance is detected immediately. **MOTARD already implements this, and it is the strongest part of the project.**

### 2. Append-only books (never delete, never edit in place)
Serious accounting software never deletes an entry. Cancellation happens through a **reversing entry** carrying the same reference. This produces a complete, tamper-evident audit trail. **MOTARD already uses cancel-by-reference and an append-only stock movement log — the same principle.**

### 3. Atomicity via transactions (ACID)
The invoice, its lines, the stock effect, the ledger entry, and the cashbox effect are all written inside **one transaction**: all of it, or none of it. This is what prevents a "half invoice" surviving a power cut or a crash. **MOTARD already does this.**

### 4. Balances are derived, not stored — or stored with periodic reconciliation
A balance = the sum of its entries, not a field updated by hand. If a stored balance is used for speed, a reconciliation mechanism must exist to verify that the stored value equals the derived one. **MOTARD already has reconciliation tests confirming statement = ledger = remaining balance.**

### 5. Measurement and indexing before scale (this is specifically where MOTARD is currently weak)
Software that survives for decades has been tested against millions of entries *before launch*, every critical query has a matching index, and yearly archiving is built in from day one. In MOTARD's current state:
- Performance has **never actually been measured** (the remediation plan itself admits this).
- The `returns.original_invoice_id` index is **missing**.
- Archive tables exist but are **not wired into anything** — there is no functioning archival strategy.

This specific gap is exactly what separates "a program that works today" from "a program that still works after 10 years and 100,000 invoices."

### 6. Backup and disaster recovery
"Not a single unit goes missing" doesn't just mean accurate math — it means **data is never lost**. Mature software enforces regular automatic backups and point-in-time restore capability. The desktop incident on this project (data loss on 2026-09-23) showed this layer is currently missing or unproven — **no backup was found, and boot decisions were never logged.**

### 7. Field-tested maturity over time
Long-established products have been used by thousands of users who have already hit the edge cases, which get fixed gradually over years. MOTARD is relatively new and hasn't been through that field-wear yet — this can be partially compensated for with **deliberate, rigorous testing and load measurement**, which is precisely what's being proposed.

### Direct comparison

| Factor | What mature software does | MOTARD's current state |
|--------|---------------------------|--------------------------|
| Double-entry as source of truth | Yes | Yes ✓ |
| Append-only + reversing entries | Yes | Yes ✓ |
| Atomic transactions | Yes | Yes ✓ |
| Balance reconciliation | Yes | Yes (tested) ✓ |
| Every critical query indexed | Yes | Partially missing ✗ |
| Load tested before launch | Yes | Never measured ✗ |
| Multi-year archiving/retention | Yes | Exists but not wired in ✗ |
| Guaranteed backup/restore | Yes | Missing / unproven ✗ |

### The conclusion of Part 1

These products don't survive because of their programming language or framework. They survive because they commit to: **double-entry, immutable books, atomic transactions, up-front measurement, disciplined backups, and years of field hardening.**

MOTARD already has the correct financial core (points 1–4) — the hardest part, engineering-wise — and is already at that level there. What's missing to reach "ten years without loss" is the **surrounding layers**: real performance measurement, complete indexing, active archiving, and guaranteed backup/restore. These four specific things — not a language or framework change — are what stand between MOTARD and the durability level of established products.

---

## Part 2 — Thinking Like an Engineering Firm Hired to Build a Decade-Long System

Imagine we are the engineering firm that took over the MOTARD ERP project, and management told us:

> "We want this system to live for 10 years, serve thousands of customers, invoices, and transactions, and we do not want to lose a single unit of currency, and we do not want it to become slow or unmaintainable."

This changes the entire way of thinking, compared to an ordinary CRUD project.

A long-lived accounting ERP is not built on the principle:

> "The invoice was saved to the database, so everything is fine."

It is built on the principle:

> **Every financial movement must have a provable fact, a traceable path, a result that can be recomputed or reconciled, and a way to recover it after a disaster.**

---

## Part 3 — Accounting Is Not CRUD

In an ordinary application you have:
```
Create · Read · Update · Delete
```
For example:
```
Customer.balance = 500
```
After a payment:
```
Customer.balance = 300
```
Done.

**This kind of thinking is dangerous in an ERP**, because the real question becomes: *why* did the balance become 300?

You need to know:
```
Previous balance = 500
Invoice          = 800
Payment          = 500
Return           = 0
Adjustment       = 0
Final balance    = 300
```

And more importantly:
- Where did the 500 come from?
- Which document?
- Which date?
- Which currency?
- Which exchange rate?
- Which user?
- Which device?
- Was it duplicated?
- Was it edited?
- Was it cancelled?

This is why a real accounting system needs **transaction history**, not just current state.

---

## Part 4 — You Must Define a "Source of Truth"

A strong design must answer: *what is the base fact that the system is never allowed to invent?* For accounting:
```
Financial Document
       ↓
Accounting Posting
       ↓
Ledger
```
The **ledger** becomes the official record of what happened. Things like `customer balance`, `daily sales total`, `profit`, and `dashboard total` are usually **derived results** from that base fact.

This is a genuinely dangerous distinction if handled wrong. If `customer_balance = 100000` is stored directly and a crash happens mid-update, what do you do? If you have a correct historical ledger, you can **re-derive** the balance. If `customer_balance` is the *only* truth, you may have lost the information that explains how the system arrived at that number in the first place.

### Source of Truth vs. Cache

`ledger_entries` is likely the accounting source of truth. `party_balances`, `dashboard totals`, `monthly summaries`, and `cached profit` can be materialized/derived data.

```
If the cache is lost      → REBUILD
If the source of truth is lost → DISASTER
```

For every table in MOTARD, ask: **is this table the truth, or a derived copy?** If you don't know the answer, that's an architecture problem.

---

## Part 5 — Worked Example: SYP → USD

Suppose an invoice is `1,000,000 SYP`, and the business rule allows the customer to pay in USD using the exchange rate in effect **at the moment of payment**.

At payment time: `Current rate = 10,000 SYP/USD`, so `1,000,000 ÷ 10,000 = 100 USD`.

A professional system does **not** just store `payment = 100 USD`. A month later, if the rate becomes `15,000`, the historical transaction becomes unexplainable unless its historical context was preserved. You need to retain:
```
payment currency     = USD
invoice currency     = SYP
exchange rate used   = 10,000
foreign amount       = 100 USD
base/equivalent amt  = 1,000,000 SYP
payment timestamp    = ...
```

**Important clarification:** this is not a prescription of what MOTARD's business rule must be — it's an illustration of the engineering principle. The rule is:

> **Implement the business rule that already exists, freeze the historical facts it produces, and never let a re-read of the exchange rate a month later change the historical record of the transaction.**

Whether the project's rule is "rate at payment time" or "rate at invoice time," whichever it is — preserve it as recorded. The engineer does not invent the business rule.

---

## Part 6 — Why the Operation Must Be Atomic

Take invoice `#500` for `100,000 SYP`. Completing the sale might touch:
```
Invoice + Invoice Lines + Stock Deduction + COGS + Ledger + Payment + Cashbox + Outbox + Audit
```
What if `INSERT invoice` succeeds and then power is lost before the rest completes?
```
Invoice ✅   Stock ❌   Ledger ❌   Payment ❌
```
Catastrophic. So business-mutation operations must run inside a correct transaction wherever atomicity is required:
```
BEGIN
  insert invoice
  insert lines
  update stock
  create ledger
  create payment
  create cashbox movement
  create outbox
COMMIT
```
On error: `ROLLBACK`, leaving `Invoice ❌ / Stock unchanged ✅ / Ledger unchanged ✅ / Payment unchanged ✅`. No such thing as a half-invoice. This is one of the strongest barriers against losing financial truth.

---

## Part 7 — But Transactions Alone Are Not Enough

This is where the real engineering begins. Suppose the user clicks **Pay**, the server executes the payment, but the response never reaches the client because the connection drops. The UI shows **Error**. The user assumes nothing happened and clicks **Pay** again.

Without idempotency:
```
Payment #1 = $100
Payment #2 = $100
```
The customer paid `$100`, but the system recorded `$200`. A financial system needs **idempotency**: an `operation_id` (UUID), where every retry of the same logical operation reuses the same ID, and the database enforces that `(same tenant + same operation_id)` cannot create a second mutation.

This does not just prevent bugs — it prevents a network retry from turning one correct transaction into a duplicated financial one.

---

## Part 8 — Why the Ledger Must Be Fully Auditable

For an invoice of `1,000,000 SYP`, it is not enough to know `invoice.status = PAID`. You must be able to see the actual **accounting impact** the document produced. In double-entry: `Debit / Credit`, and the fundamental rule is `Σ Debits = Σ Credits`.

If you ever reach `Debit = 1,000,000` and `Credit = 900,000`, that is not "a small discrepancy" — it is a broken financial invariant, and the database/application/test suite should be designed so that this kind of state is difficult or impossible to reach. (Al-Amin's public documentation, for instance, explicitly mentions integrity-audit tooling that checks for things like unbalanced entries or an invoice with no corresponding posting — which underlines how central integrity checking is in a long-lived ERP.)

---

## Part 9 — Editing an Old Invoice

This point matters a great deal. In plain CRUD: `UPDATE invoice SET total = 50`. In a financial system, you do not want to erase history in a way that makes it impossible to know what actually happened. The correct model:
```
Original Document → Correction / Reversal → Corrected Document
```
The old financial fact remains auditable, and the correction is recorded separately. A year later you can see:
```
Original    = 100,000
Correction  = -20,000
Final       = 80,000
```
— not just `current total = 80,000`, because the current number alone does not tell the story.

---

## Part 10 — "Delete" in a Financial System Is Not Like Delete in an Online Store

In ordinary CRUD, `DELETE FROM invoice` may be normal. In a financial ERP, ask first: **is this invoice a historical document that was already posted?** If yes, "delete" may be inherently wrong. What's needed instead, depending on the business rule, is: **Cancel, Reverse, Void, or Correct.** This isn't complexity for its own sake — the reason is **auditability**.

---

## Part 11 — Why Mature Software Survives for Years

The secret isn't PostgreSQL or SQL Server specifically. The secret is that the data is designed to be able to grow. `10,000 invoices` doesn't mean just 10,000 rows — it might mean:
```
10,000 invoices
100,000 invoice lines
100,000 stock movements
40,000 ledger entries
30,000 audit events
10,000 sync events
```
or more. So the right question is never "how many invoices do I have?" — it's **how many business events did those invoices produce?**

---

## Part 12 — Write Path vs. Read Path

This is one of the most important ERP architecture ideas.

**Write path** — when recording an invoice, what matters most: correctness, atomicity, integrity, consistency, idempotency, concurrency safety. It doesn't matter if the operation takes 5ms instead of 10ms if it can lose data.

**Read path** — dashboards, reports, search, statements, profit: here you want indexes, pagination, aggregation, caching, summaries, materialized views, optimized SQL, and partitioning where justified.

The specific issue found in the MOTARD report was that some **read paths** scan large amounts of historical data — meaning slowness at 2,000 invoices doesn't necessarily mean invoice **writing** itself is weak. This distinction matters a great deal.

---

## Part 13 — A Worked Example of an Architectural Mistake That Kills a Program Over Years

Imagine a customer statement. At 500 movements, `SELECT all` looks great. After 5 years: `500,000 ledger rows`. Every time the user opens that customer's statement:
```
SELECT 500,000 → Node parses → JSON → Frontend → React → browser memory
```
becomes slow. Not because PostgreSQL is "bad" — because the architecture asked it to do unnecessary work. The fix is not "add more CPU." It's:
```
pagination + proper index + date range + server-side aggregation + summary/opening balance
```
so that if the user asks for `January 2026`, the system doesn't read the company's entire history back to 2018.

---

## Part 14 — Fiscal Periods Matter

A long-lived system needs the concept of a **fiscal period** (or at least an accounting year) — `2024, 2025, 2026` — with an **opening balance** carried into the following year. Instead of "compute the customer's balance from day one of the system's history," you compute:
```
Opening balance + movements during the selected period = closing balance
```
This dramatically reduces the work required. (Al-Amin's official documentation does deal with the concept of files/periods and reports spanning years.)

---

## Part 15 — Never Store Only the Summary and Discard the Detail

A common mistake: "let's just store the customer's balance." **No.** The correct approach is:
```
Detailed truth + derived summary
```
`ledger_entries` stays. `party_balance_summary` can exist for read speed.
```
If the summary breaks → REBUILD
If the ledger disappears → DISASTER
```
A very strong rule in financial system design.

---

## Part 16 — Inventory Follows the Same Philosophy

A fabric roll: `1000 kg`, then `Sale -100kg, Sale -50kg, Return +20kg, Adjustment -10kg`, balance = `860kg`. You need clarity between **current balance** and **movement history**, and you don't want every stock view request to `SELECT every stock movement since 2018` and `SUM(...)`. Where the current invariant can be kept correctly, with movements recorded for audit, reads become much easier.

This is close to what was already found in MOTARD's analysis: the current inventory design is built as an **invariant**, not a full replay of movement history. This should be preserved if it matches the current design.

---

## Part 17 — Concurrency Is a Major Risk

`Roll A = 100kg`, and two computers act at once:
```
Computer A → sell 80kg
Computer B → sell 50kg
```
If both read `remaining = 100` before either writes, both will believe their sale is valid.
```
A → 20kg left
B → 50kg left
Actual: 100 - 80 - 50 = -30
```
If the policy forbids negative stock, this is unacceptable. This needs concurrency control: `FOR UPDATE`, optimistic versioning, unique constraints, or an atomic conditional update — depending on the design. This is also exactly why an AI assistant should not redesign inventory just because it found a "nicer-looking" approach.

---

## Part 18 — Database Constraints Are an Additional Guard

Do not rely only on application-level `if (...)` checks in TypeScript, because there is more than one path to reach the database. Protection must also exist **at the database level** where it matters: `FOREIGN KEY`, `UNIQUE`, `CHECK`, `NOT NULL`. If `invoice_line.invoice_id` exists, the system must never allow a line referencing a non-existent invoice — this is **referential integrity**.

---

## Part 19 — Backups Are Not Just "Copy the Database"

This is a critical point for any real engineering firm. A team says: "we do a backup every day." The next question is always: **have you tested restoring it?** If the answer is no, **the backup is unproven** — the file might exist while being corrupt, incomplete, the wrong database, the wrong version, missing attachments, or missing its encryption key.

The required chain is:
```
Backup → Store → Verify → Restore Test → Integrity Check
```
and the restore must be able to bring the system back to a genuinely usable state. (Al-Amin's documentation, for example, notes that real data lives inside SQL Server rather than a shortcut file, and warns about understanding this correctly for backup purposes.)

### RPO and RTO
A real engineering team asks:
- **RPO** (Recovery Point Objective) — how much data can we afford to lose at most? e.g. `RPO = 15 minutes`.
- **RTO** (Recovery Time Objective) — how long is the system allowed to be down? e.g. `RTO = 2 hours`.

These are different questions from "we have a backup."

---

## Part 20 — Audit Log

You need to know: `User A, 2026-09-23 12:20, changed invoice #500`. What changed — before and after? From which device? Why? Was it a create, update, cancel, payment, or correction? This is an **audit trail** — not just recording `user = Ahmed`, but recording **what happened**. (Al-Amin's own documentation, for instance, offers a logging option to track additions, edits, and deletions — a direct example of why this matters in a long-lived ERP.)

---

## Part 21 — You Need a Reconciliation Engine

Perhaps the single most important idea to add to MOTARD's thinking: the system should not only **process** — it should also **verify itself**.

| Domain | Invariant to check |
|--------|---------------------|
| Accounting | Total Debits == Total Credits |
| Invoice | Invoice Total == Sum(lines) |
| Payment | Paid + Remaining == Invoice Total |
| Inventory | Stock invariant consistent with allowed movements |
| Ledger | Document ↔ Ledger stay synchronized |
| Sync | Local mutation ↔ outbox ↔ remote acknowledgement |

These can be run as an **Integrity Check**. (Al-Amin's public documentation specifically discusses file-integrity auditing, mentioning things like unbalanced entries or an invoice with no corresponding posting, along with material-balance and pricing audits.) This kind of integrity tooling matters greatly for MOTARD.

---

## Part 22 — What Happens If the Program Fails Mid-Sync?

Imagine: invoice created locally → outbox entry created → internet dies. The transaction must not be lost. So the **business transaction** and the **outbox insert** must be linked:
```
BEGIN
  create invoice
  create ledger
  create stock mutation
  create outbox event
COMMIT
```
On success, you have `local truth + durable sync intent` together. Later, a **Sync Worker** handles delivery. This is the **Transactional Outbox** pattern — far stronger than "save invoice ... then call API," because the network should never be a precondition for completing a local business transaction.

---

## Part 23 — What If the Same Event Arrives Twice?

Normal in distributed systems. Event `#ABC` may arrive twice. The correct behavior: `"ABC already applied → do nothing"`, not `apply, apply again`. This is exactly why **Idempotency Keys** exist. In a financial project, this is not a luxury — it is a necessity.

---

## Part 24 — Conflict Resolution

Two offline devices, A and B, both affect the same customer's balance. When connectivity returns and sync runs, you cannot simply say "last write wins" and move on. That might be acceptable for some non-financial data, but it can be catastrophic for **payment, stock, or any financial mutation**. You must explicitly define:
- What can conflict?
- Who owns it?
- What is the resolution rule?
- Can it be merged?
- Must it be rejected?
- Must it require human resolution?

---

## Part 25 — Why Some Systems Use SQL Server (or Similar)

Not because SQL Server is "magic," but because a professional database engine provides: transactions, locks, indexes, constraints, recovery, backup, concurrency, and a query optimizer. (Al-Amin officially states that company-file data is managed within SQL Server; Amwal also distributes SQL Server as part of its published requirements/packages.)

But **PostgreSQL**, which MOTARD already uses, can fill these same roles excellently — if it is designed and used correctly. The real question is never "PostgreSQL or SQL Server?" — it is **"how did we actually use the database?"**

---

## Part 26 — Why "Only 2,000 Invoices" Is the Wrong Frame

Stop thinking "2,000 is a small number, why is the program slow?" Because `2,000` may just be the trigger for much larger downstream computation:
```
2,000 invoices × 10 lines = 20,000 lines
+ stock movements + ledger + audit + sync
```
And it can get worse: a dashboard running 20 queries, some of which read the entire history, followed by JavaScript aggregation, JSON serialization, and React rendering. At 500 invoices: fine. At 2,000: noticeable. At 10,000: bad. But the **write path** itself may still be excellent.

This is exactly why the earlier MOTARD report showed an important distinction between writing and reading: invoice creation itself was bounded by the number of lines on that invoice, while some dashboard/search/statement paths touch the wide historical dataset.

---

## Part 27 — Performance Must Be Fixed Scientifically, Not Blindly

Do not simply: add caching everywhere, add Redis, buy a stronger server, or rewrite PostgreSQL — before knowing the actual cause. The engineering process is:
```
Measure → Profile → Identify bottleneck → Fix root cause → Benchmark → Regression test
```
`EXPLAIN ANALYZE` might reveal a sequential scan over 300,000 rows → add the right index. If the actual problem is "the browser is rendering 20,000 rows," no index will help — the fix is in the UI. If the problem is 25 sequential queries, look at batching/parallelization (with the concurrency safeguards discussed earlier).

---

## Part 28 — Four Levels of Testing Required for MOTARD

1. **Unit tests** — invoice calculation, FX, profit, stock.
2. **Integration tests** — invoice → DB → ledger → stock → payment.
3. **Integrity / reconciliation tests** — documents ↔ ledger ↔ balances ↔ inventory.
4. **Load/scale tests** — 2K, 10K, 50K, 100K.

The distinction matters: unit tests can be **100% passing** while the program is still extremely slow at 50K records. All four levels are required, not just the first two.

---

## Part 29 — Migration Discipline

After 5 years you'll have `migration 001` through perhaps `migration 200`. The team must be able to answer: **which version of the software can create a correct database?** It must never be the case that a migration claims a column exists while the runtime expects something different. `Schema source + migration history + runtime expectations` must stay in agreement.

---

## Part 30 — Data Retention

Not everything needs to live forever in the same hot tables. Active operational data can stay in the primary tables; very old data can be **archived** — but accounting archiving must remain auditable and retrievable, not just `DELETE old rows`.

For MOTARD, the question is not "do archive tables exist?" — it's **"do the existing archive tables actually work?"** This is exactly what the earlier MOTARD review found: archival/summary structures exist but are not wired into the actual usage path, per the report examined.

---

## Part 31 — Performance Is Not Just the Database

You have PostgreSQL, but also Node, the API layer, JSON, Tauri, Rust, IPC, React, the DOM, and browser memory. PostgreSQL might return `20,000 rows` extremely fast — then Node does `JSON.stringify(20,000 rows)`, the frontend does `JSON.parse(...)`, then `filter / sort / map`, then React renders `20,000 components`, and the program becomes slow anyway. The bottleneck may not be the database at all.

---

## Part 32 — Why Old Software "Feels" Robust

Not magic code. Mature products typically have years of accumulated thinking about edge cases: power failure, duplicate clicks, network failure, wrong dates, year-end closing, user permissions, invalid stock, database corruption, backup, restore, audit, concurrency, old data, large data, printer failure, hardware replacement, migration.

A new project usually focuses on the **happy path**. A mature project focuses on **"what if everything goes wrong?"** That is the real difference.

---

## Part 33 — The Ten-Layer Architecture for MOTARD

If this firm were responsible for MOTARD, here is the layering principle:

| Layer | Guiding question |
|-------|-------------------|
| 1. Business Truth | What does the transaction mean? |
| 2. Accounting / Inventory Invariants | What must ALWAYS remain true? |
| 3. Transactional Database | Can a crash leave partial state? |
| 4. Idempotency / Concurrency | What if the same operation happens twice? |
| 5. Audit | Can we explain why the number is what it is? |
| 6. Reconciliation | Can the system detect if something became inconsistent? |
| 7. Backup / Recovery | Can we recover after disaster? |
| 8. Performance | Can it do all of this with 100k+ records? |
| 9. Monitoring | How do we know something is starting to go wrong? |
| 10. Testing | Can we prove every layer keeps working after changes? |

---

## Part 34 — The Single Most Important Sentence in This Document

I do not want MOTARD to be:

> "A program where, if something breaks, we fix it."

I want its philosophy to be:

> **A program designed so that it is hard for an error to happen in the first place; if it happens, the system can detect it; if a disaster happens, it can recover the truth; if data grows large, it does not collapse; and if the code changes, the financial meaning does not.**

This is the difference between an **ERP application** and a **long-lived financial system**.

---

## Part 35 — What This Means for the AI Working on MOTARD

The AI must never approach the codebase by saying:

> "This code is old, I'll rewrite it."

Instead, the required thought process is:

```
What is the business invariant?
        ↓
What is the current implementation?
        ↓
Is the implementation correct?
        ↓
What exactly is broken?
        ↓
Where else does this same issue occur?
        ↓
What is the smallest safe repair?
        ↓
Does the repair preserve historical meaning?
        ↓
How do we prove it?
```

Especially in: **accounting, FX, payments, inventory, profit, COGS, ledger, and synchronization.**

The standard is never *"the new code looks nicer."* The standard is:

> **"Does the financial output after the fix match the intended business rule exactly?"**

---

## Part 36 — Closing Summary

Companies that want an ERP to survive for years do not protect themselves with a strong database alone. They build an entire system:

```
                ┌─────────────────────┐
                │   BUSINESS RULES    │
                └──────────┬──────────┘
                           ↓
                ┌─────────────────────┐
                │ FINANCIAL INVARIANTS│
                └──────────┬──────────┘
                           ↓
                ┌─────────────────────┐
                │ ATOMIC TRANSACTIONS │
                └──────────┬──────────┘
                           ↓
                ┌─────────────────────┐
                │ DATABASE CONSTRAINTS│
                └──────────┬──────────┘
                           ↓
                ┌─────────────────────┐
                │ IDEMPOTENCY + LOCKS │
                └──────────┬──────────┘
                           ↓
                ┌─────────────────────┐
                │    AUDIT TRAIL      │
                └──────────┬──────────┘
                           ↓
                ┌─────────────────────┐
                │   RECONCILIATION    │
                └──────────┬──────────┘
                           ↓
                ┌─────────────────────┐
                │  BACKUP + RESTORE   │
                └──────────┬──────────┘
                           ↓
                ┌─────────────────────┐
                │ PERFORMANCE / SCALE │
                └──────────┬──────────┘
                           ↓
                ┌─────────────────────┐
                │ TEST + MONITORING   │
                └─────────────────────┘
```

### What this means for the next phase of MOTARD specifically

The next phase should not be limited to "fix the issues found in the report." The `REPAIR-PLAN.md` that gets executed must also guarantee that **every fix preserves this full chain**:

```
financial invariants → transaction atomicity → idempotency → auditability
      → reconciliation → recovery → scalability
```

This is precisely what allows the software to handle years of invoices and transactions, instead of remaining an application that merely works well when the data set is still small.