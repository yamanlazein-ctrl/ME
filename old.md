Motard ERP — 50 Long-Term Verification
Evidence from the current repository only (schema, repositories, middleware, tests, scripts). No production load test was executed. Date of review: 2026-09-23.

4
YES
41
PARTIAL
3
NO
2
NOT PROVEN
Headline risks (do not ignore)
Statement API loads the entire ledger window with no pagination. Inventory/parties preload up to ~10k rows into browser RAM. HTTP idempotency is a 5-minute retry cache, not a permanent pay-once business key. Customer merge does not exist. Profit return effects follow invoice date, not return date. Legacy COGS can follow live roll price when costPerKg is null. perf-harness is a scaffold — scale is not proven.
Filters
Domain


All
Verdict


All
Open detail


Q1. Year-end customer statement completeness & reconcile
Showing 50 / 50

All questions
#	Question	Domain	Verdict
1
Year-end customer statement completeness & reconcile	Customer / Statement	
2
Multi-year statement, opening balance, historical immutability	Customer / Statement	
3
Customer with tens of thousands of transactions	Customer / Statement	
4
Customer name change after thousands of docs	Customer / Statement	
5
Duplicate customers / same name	Customer / Statement	
6
Customer identity stability	Customer / Statement	
7
Customer merge	Customer / Statement	
8
Delete customer with history	Customer / Statement	
9
Year-end Opening + Invoices − Payments − Returns = Closing	Customer / Statement	
10
Statement vs GL vs payment history vs invoice history	Customer / Statement	
11
3650 invoices/year operational usability	Performance / Frontend	
12
Year-end profit report correctness	Profit / FX	
13
Profit after years / date leakage / double-count returns	Profit / FX	
14
Profit revenue vs manual invoice sum	Profit / FX	
15
COGS cost basis stability	Profit / FX	
16
Historical FX mutation	Profit / FX	
17
Multi-currency payment (SYP invoice / USD cash)	Profit / FX	
18
Partial multi-currency payments	Profit / FX	
19
Rounding difference handling	Profit / FX	
20
Payment retry after network failure	Concurrency / Idempotency	
21
Double-click payment	Concurrency / Idempotency	
22
Two devices settle same invoice	Concurrency / Idempotency	
23
Return after full payment	Concurrency / Idempotency	
24
Partial payment → partial return → payment → settle	Concurrency / Idempotency	
25
Cancelled invoice reverses effects	Concurrency / Idempotency	
26
Inventory after thousands of movements	Inventory	
27
100k rolls product lookup	Inventory	
28
Inventory corruption detection	Integrity / Backup	
29
Concurrent stock sales oversell	Inventory	
30
Product name change after heavy use	Inventory	
31
Editing roll descriptive info after sales	Inventory	
32
Large document number range uniqueness	Sync / Docs	
33
Offline invoice creation then sync	Sync / Docs	
34
Offline many days / large backlog	Sync / Docs	
35
Crash during sync recovery	Sync / Docs	
36
DB failure mid invoice create atomicity	Sync / Docs	
37
Power failure consistency	Integrity / Backup	
38
Backup and restore	Integrity / Backup	
39
Multi-year integrity verification	Integrity / Backup	
40
DB growth bottlenecks 100k→100M	Performance / Frontend	
41
Report performance after years	Performance / Frontend	
42
Dashboard performance after years	Performance / Frontend	
43
Invoice/customer search at 100k–1M	Performance / Frontend	
44
Long-running memory growth	Performance / Frontend	
45
Frontend loads thousands for one page?	Performance / Frontend	
46
API response size bounds	Performance / Frontend	
47
Index health vs queries	Performance / Frontend	
48
Delete/archive historical safety	Integrity / Backup	
49
Code change safety / dual implementations	Architecture	
50
Complete 10-year ERP failure-test guarantees	Architecture	
Q1. Year-end customer statement completeness & reconcile
Customer / Statement

Proven
Statement is ledger-driven: loads every ledger_entries row for the party in the date/currency window, shows cancelled rows, excludes them from running balance. Reconcile test covers 10 invoices + receipts + cancel + return + FX freeze.

Evidence
PostgresStatementRepository.getStatement SELECT * FROM ledger_entries WHERE party_id… ORDER BY date, createdAt. TYPE_LABEL covers invoices, receipts, payments, returns, settlements, FX, adjustments. customer-statement-reconcile.test.ts asserts statement === ledger === (total−paid−returns).

Affected files
backend/src/infrastructure/repositories/PostgresStatementRepository.ts; backend/src/domain/entities/Statement.ts; backend/tests/customer-statement-reconcile.test.ts

Tables
ledger_entries, parties, invoices, vouchers, invoice_lines, returns

Data flow / internals
HTTP statement.route → statementRepo.getStatement → party lookup → prevBalance SUM before fromDate → full window rows → attach invoice/voucher document snapshots → running balance in memory → totalsByCurrency

Risks
No pagination: entire window returned to browser. Statement display names come from live parties/fabrics joins (not frozen name-at-posting). Year-scale volume untested beyond ~10 invoices in automated reconcile.

Large history / years
Correctness of balance math can hold for years if ledger remains append-only and complete; delivery/usability of a year-long unpaginated statement is not proven.

Q50 pillar matrix
Concrete claim status for the 15 long-term guarantees. Nothing is marked YES without repository evidence of an implemented rule plus meaningful tests or DB enforcement.

Pillar	Verdict	Evidence note
1. Financial correctness	
Ledger append-only + TX writes; reconcile tests exist; not full formal audit.
2. Historical correctness	
Amounts frozen; display names not; legacy COGS fallback.
3. Customer statement correctness	
Ledger-correct; unbounded load; small reconcile suite.
4. Inventory correctness	
Locked remainingKg; no movement↔stock auditor.
5. Profit correctness	
Clear equation; return period attribution quirk; legacy cost fallback.
6. Currency correctness	
Explicit convertForSettlement + tests for core SYP/USD paths.
7. Synchronization correctness	
op_id/leases/seq/conflicts; backlog/chaos not fully proven.
8. Document uniqueness	
Atomic sequences + blocks + unique indexes; offline edge cases remain.
9. Data integrity	
Count-drop manifest; not deep financial/stock proofs.
10. Backup/recovery	
Scripts + thin drill + sync restore tests; needs ops cadence.
11. Query performance	
Indexes present; perf-harness scaffold only.
12. Bounded memory	
Inventory/parties preload; statement unbounded.
13. Safe concurrency	
FOR UPDATE on invoice/roll/party settle; idempotency TTL limits.
14. Reproducible historical documents	
Numbers/amounts yes; names/joins live.
15. Safe future software updates	
Tests + fingerprint; dual balance concepts can drift.
Authoritative sources (when views disagree)
Customer AR/AP balance: ledger_entries (active debit−credit / credit−debit).

Invoice amount due UX: invoices.total − invoices.paid − active returns (paid maintained by vouchers; returns not written into paid).

Stock on hand: rolls.remainingKg (movements are audit).

Document FX: rate columns on invoices/vouchers/returns/ledger at post time.

Profit: PostgresProfitRepository equation (not full ledger P&L).

What still requires real load / production-like tests
Statement with 30k+ ledger rows; 100k rolls UI; 1M invoice ILIKE search; multi-day sync backlog; power-loss mid-outbox; restore drill with independent financial checksums; concurrent multi-device settle+return matrix; heap soak for days; EXPLAIN on 10M ledger_entries.