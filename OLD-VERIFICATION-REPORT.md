# Verification of `old.md` Against the Current Repository

**Scope:** read-only verification of every claim in `old.md` against the current working tree after the recent repair pass. No source, schema, migration, database, configuration, commit, or push was changed for this report.

**Evidence labels:**

- **STILL TRUE** — the current code still exhibits the described behavior.
- **PARTIALLY TRUE** — the underlying risk remains but the claim is overstated or mitigated.
- **FIXED** — the current code contains a relevant correction and current tests support it.
- **NOT PROVEN** — the code suggests a risk, but a realistic runtime/load/recovery test is missing.
- **NOT AN ERROR** — an intentional business/design choice, or a requirement rather than a defect.

## Executive verdict

The AI agent's old report was **substantially correct**, but it mixed confirmed defects, architectural limitations, and unmeasured risks. Several points are still present after the recent repairs. The recent pass fixed the build/return regression, restored documentation, fixed the party page parameter, restored the previous rounding function, hardened SAFE_MODE, tightened restore insert behavior, and hardened lease finalization. It did **not** complete the full long-term plan.

The following headline risks are still valid:

1. Statement responses are unbounded in the repository and are not page/cursor based.
2. Inventory and party caches still preload paginated pages into module-level browser arrays; this is bounded by `fetchAllPaged`'s 50-page ceiling, not replaced by true typeahead everywhere.
3. HTTP idempotency is still a five-minute retry/cache mechanism; durable one-to-many `financial_operations` does not exist.
4. Customer merge does not exist.
5. Profit return adjustments are joined by original invoice, but no return-date filter is applied; period attribution therefore follows invoice selection rather than return date.
6. Legacy COGS still falls back to live roll price when `invoice_lines.cost_per_kg` is null.
7. `perf-harness.mjs` remains a scaffold and no production-scale performance claim is proven.

Therefore the old report did **not** invent the majority of its headline problems. It was, however, too broad when it treated every unmeasured risk as a confirmed failure.

---

## Claim-by-claim verification

| # | Old report claim | Current verdict | Current evidence / explanation |
|---:|---|---|---|
| 1 | Year-end statement completeness/reconcile | **PARTIALLY TRUE** | Ledger balance logic and reconciliation tests exist, including the live customer statement test. However `PostgresStatementRepository.getStatement` loads the complete window with no limit/cursor and materializes details in memory. Large-year completeness is not measured. |
| 2 | Multi-year statement/opening/historical immutability | **PARTIALLY TRUE** | Append-only ledger/cancellation behavior exists. Multi-year statement performance, opening-balance semantics across all filters, and long-term display reproducibility are not proven. |
| 3 | Tens of thousands of customer transactions | **STILL TRUE / NOT PROVEN AT SCALE** | The query has no pagination and no bounded response contract. Correctness may hold, but memory, response size, timeout, and UI behavior at 30K+ rows are untested. |
| 4 | Customer name change after thousands of documents | **STILL TRUE** | Statements load current party/document joins; no general party-name-at-posting snapshot is evident. Historical amounts remain stable, but displayed names can change. This is an audit reproducibility limitation, not necessarily a financial arithmetic bug. |
| 5 | Duplicate customers/same name | **PARTIALLY TRUE** | A unique `(tenant_id, name)` index exists, so exact duplicate names are blocked. That does not detect same real customer entered with spelling/phone/code variations, and there is no merge/deduplication workflow. |
| 6 | Customer identity stability | **FIXED/TRUE** | UUID IDs and tenant-scoped references provide stable identity. The remaining risk is stale frontend caches/tenant switching, which still needs exhaustive adversarial testing. |
| 7 | Customer merge | **STILL TRUE** | No merge route/use case/repository operation was found. A duplicate customer cannot be safely consolidated without a formal, auditable merge design. |
| 8 | Delete customer with history | **MOSTLY FIXED** | `PostgresPartyRepository.cancel` uses cancellation/status rather than destructive business deletion. A full audit of every related entity and UI path is still required, but the main historical-party path is fail-safe. |
| 9 | Opening + invoices − payments − returns = closing | **FIXED FOR TESTED PATHS / NOT PROVEN LONG-TERM** | Ledger is the balance authority and current reconciliation tests pass. The formula must still be tested over multi-currency, opening balances, cancellations, discounts, and large histories. |
| 10 | Statement vs GL/payment/invoice history | **PARTIALLY TRUE** | The statement is ledger-driven and core reconciliation passes. It is not a formal all-entity reconciliation service covering all orphan, stock, cashbox, credit, and sync conditions. |
| 11 | 3,650 invoices/year usability | **STILL TRUE** | A year of invoices can exceed the current broad-list/browser aggregation assumptions. The recent temporary return to `limit:1000` is not a scalable final design. |
| 12 | Year-end profit correctness | **PARTIALLY TRUE** | Profit has an explicit equation and current FX/COGS tests. Return period attribution and legacy cost fallback remain caveats. |
| 13 | Profit after years/date leakage/double-count returns | **STILL TRUE** | Invoice rows are filtered by invoice date, while return adjustments are grouped by `original_invoice_id` without filtering `returns.date` to the requested period. A return in a later period can affect an earlier invoice's period result. Whether this is intended is a business decision; as a period report behavior it is a real semantic risk. |
| 14 | Profit revenue vs manual invoice sum | **PARTIALLY TRUE** | Revenue is intentionally `subtotal - discount`, excluding tax and shipping. That is not a defect if preserved business meaning is correct. Parity tests are needed to prevent UI/manual expectations from diverging. |
| 15 | COGS cost stability | **PARTIALLY TRUE** | New sales use a stored cost snapshot and posted COGS. Pre-migration rows with null `cost_per_kg` use current `rolls.price_per_kg` in `PostgresProfitRepository`, dashboard, and return-related fallback paths; changing the roll can change legacy reports. |
| 16 | Historical FX mutation | **MOSTLY FIXED** | Invoice/voucher/return/ledger FX values are captured and the current FX tests pass. A full restore/replay and every edit/cancel path still needs proof. |
| 17 | SYP invoice / USD payment | **FIXED FOR TESTED SCENARIOS** | Cross-currency settlement tests pass and preserve settlement-rate FX legs, invoice currency, cash currency, and balance closure. Broader concurrency/retry testing remains. |
| 18 | Partial multi-currency payments | **FIXED FOR TESTED SCENARIOS** | Current cross-currency and statement-payment tests pass. This does not prove all concurrent multi-device combinations. |
| 19 | Rounding differences | **PARTIALLY TRUE** | The unapproved EPSILON change was reverted. The project still uses JavaScript number arithmetic with PostgreSQL numeric storage; a formal decimal/string parity policy across all currencies and magnitudes is not proven. |
| 20 | Payment retry after network failure | **STILL TRUE** | HTTP idempotency protects a retry only while the cached durable key is within the five-minute TTL. There is no permanent business operation record storing and replaying the final result. |
| 21 | Double-click payment | **PARTIALLY TRUE** | Atomic claim reduces concurrent duplicate execution for the same key, and required routes reject missing keys. Different keys or a retry after TTL can still create separate operations; this is correct only if they are truly separate logical operations. Durable financial idempotency is incomplete. |
| 22 | Two devices settle same invoice | **NOT PROVEN / RISK REMAINS** | Repository guards and transactions exist, but the complete simultaneous settlement race matrix with two devices, different keys, returns, and credit is not demonstrated by the current suite. |
| 23 | Return after full payment | **FIXED FOR TESTED PATHS** | Return creation and customer statement reconciliation now pass after restoring the missing declarations. Full business matrix is still needed. |
| 24 | Partial payment → return → payment → settle | **PARTIALLY TRUE** | Core remaining/return/settlement logic exists and tests cover related flows, but the exact long sequence under retries/concurrency is not proven end-to-end. |
| 25 | Cancelled invoice reverses effects | **FIXED FOR TESTED PATHS** | Cancellation, stock, ledger, and reconciliation tests exist. Long-history and crash-boundary recovery remains unproven. |
| 26 | Inventory after thousands of movements | **PARTIALLY TRUE** | Roll state is locked and stock movement history exists. There is no complete movement-to-roll reconciliation auditor or large-history benchmark. |
| 27 | 100k rolls product lookup | **STILL TRUE** | `useInventory.loadAll` still calls `fetchAllPaged` and stores fabrics, colors, and rolls in module-level browser arrays. `fetchAllPaged` has a 50-page/200-size ceiling; this is not server-side typeahead and cannot prove 100K usability. |
| 28 | Inventory corruption detection | **STILL TRUE / PARTIAL MITIGATION** | Data-integrity manifest checks row counts, but it does not prove stock movement replay equals roll state. A reconciliation service is planned but not complete. |
| 29 | Concurrent stock sales oversell | **FIXED FOR CORE PATHS / NOT PROVEN UNIVERSALLY** | Ordered roll locks and version checks exist, and invoice concurrency tests exist. Every inventory adjustment/return/cancel/sync path still needs the same race matrix. |
| 30 | Product name change after heavy use | **PARTIALLY TRUE** | IDs and current names are stable for joins, but historical document name snapshots are not universal. This affects reproducible historical presentation, not numeric identity. |
| 31 | Editing roll descriptive info after sales | **NOT AN ERROR BY ITSELF** | A roll is referenced by stable ID and descriptive edits need not change historical accounting. It becomes a problem only if the business requires immutable historical labels; that requires a decision and snapshots. |
| 32 | Large document-number uniqueness | **PARTIALLY TRUE** | Database unique constraints, sequences, blocks, and sync numbering exist. Offline multi-device crash/reclaim/restore scenarios are not fully load-tested. |
| 33 | Offline invoice then sync | **PARTIALLY TRUE** | Durable outbox/inbox, op IDs, leases, conflicts, and materialization exist. End-to-end packaged offline/reconnect proof is incomplete. |
| 34 | Offline many days/large backlog | **STILL TRUE / NOT PROVEN** | The design has batching and lanes, but there is no measured backlog drain test at 10K/100K/1M events and no proven hub compaction/bootstrap. |
| 35 | Crash during sync recovery | **PARTIALLY FIXED** | Lease-token finalization was hardened and stale finalization is guarded. Process-kill, expired lease, renewal, and side-effect suppression tests still need to be added/run. |
| 36 | DB failure during invoice atomicity | **FIXED FOR TESTED TRANSACTION PATHS** | Core invoice transaction tests and outbox ambient wiring exist. Power-loss and injected DB failure at each write boundary are not fully proven. |
| 37 | Power failure consistency | **NOT PROVEN** | Rust lifecycle tests exist, but there is no packaged Windows power-loss/crash matrix proving database, files, logs, migrations, and sync recover consistently. |
| 38 | Backup and restore | **PARTIALLY TRUE** | Snapshot/backup/restore building blocks and warning refusal exist. Restore staging, filesystem/database atomicity, encryption, attachment checksums, scheduler drills, and rollback under mid-restore failure are not fully proven. |
| 39 | Multi-year integrity verification | **STILL TRUE** | Manifest/count checks exist, but a full read-only ledger/stock/cashbox/invoice/sync reconciliation service and periodic operational drill are incomplete. |
| 40 | DB growth 100k→100M | **STILL TRUE** | No representative scale benchmark or storage/WAL/autovacuum/bloat study was executed. This is an unproven scalability requirement, not evidence of a current crash. |
| 41 | Report performance after years | **STILL TRUE** | Several report consumers still use broad bounded lists or browser aggregation. Full server-side aggregate migration and p95/p99 measurement are incomplete. |
| 42 | Dashboard performance after years | **PARTIALLY TRUE** | Currency-mixing intent was corrected and query work improved, but dashboard fan-out, historical scans, and SQL aggregation still require measured workload proof. |
| 43 | Search at 100k–1M | **STILL TRUE / NOT PROVEN** | Search escaping was corrected, but substring `ILIKE` scalability and trigram/index decisions have not been measured at 100K–1M. |
| 44 | Long-running memory growth | **NOT PROVEN / RISK** | Module-level caches and broad statement/report responses create plausible growth risks. No multi-day heap soak test exists. |
| 45 | Frontend loads thousands for one page | **STILL TRUE** | `useInventory` and `useParties` preload arrays; statements remain unbounded. `fetchAllPaged` only limits the damage and can silently stop at max pages. |
| 46 | API response size bounds | **STILL TRUE** | Statement and some detail/report endpoints have no explicit response-size/page contract. Other list APIs are bounded but consumers often aggregate multiple pages. |
| 47 | Index health vs queries | **PARTIALLY TRUE** | Return/manual-movement indexes and schema parity work exist. Index duplication/drift and EXPLAIN evidence still require a systematic query/index audit. |
| 48 | Delete/archive historical safety | **PARTIALLY TRUE** | Financial cancellation is append-oriented, but manual cash movement deletion remains a policy decision and archive tables are not a complete active archive strategy. |
| 49 | Code change safety/dual implementations | **STILL TRUE** | There are multiple implementations/authorities for cash, reports, precision, contracts, and caches. The authority map helps, but full consolidation and parity gates are incomplete. |
| 50 | Complete ten-year failure-test guarantees | **NOT PROVEN** | The project now has many tests and stronger gates, but no proof exists for ten-year data growth, power loss, restore cadence, upgrade history, sync compaction, or production workload.

---

## What the old report got wrong or overstated

1. **It should not call every item an active bug.** Several are scale/operational requirements that are simply NOT PROVEN: 100M-row growth, 1M search, multi-day heap, arbitrary power failure.
2. **It did not account for the latest fixes.** Return creation, backend/frontend TypeScript, documentation restoration, SAFE_MODE auth path, rounding rollback, party `page`, restore conflict behavior, and lease-token finalization have changed since the earlier tree state.
3. **A five-minute HTTP idempotency TTL is not automatically a defect for every endpoint.** It is insufficient for permanent financial exactly-once semantics, but it is valid as a retry cache when paired with a durable operation record. The durable operation record is the missing part.
4. **Current-name display is not automatically wrong.** It is an audit/reproducibility limitation. The business may intentionally want current names in statements; approval is required before adding snapshots.
5. **Return-date attribution is a semantic/business decision.** The code currently attributes return adjustment to the original invoice's selected period. That is a real report-period risk, but changing it without a business decision would alter profit meaning.
6. **Product/roll descriptive edits are not financial corruption.** They become a historical-document issue only if immutable descriptive snapshots are required.

## Highest-priority remaining real issues

1. Build and tests are now green, but no packaged Desktop build/upgrade test has been run.
2. Permanent financial operation identity for one-to-many settlement is still missing.
3. Statement API remains unbounded.
4. Inventory/party preload remains browser-memory based and capped by a silent page ceiling.
5. Profit period attribution for returns needs an explicit business decision and a test.
6. Legacy COGS fallback to live roll price remains for old rows.
7. Restore still needs staging-first/database-plus-files verification and failure rollback drills.
8. Desktop superuser bypasses RLS unless the application-role decision is implemented.
9. Full reconciliation (ledger, invoice, stock, cashbox, credit, sync) is not yet an operational service.
10. Scale, soak, crash, backlog, and 100K/1M query performance remain NOT MEASURED.

## Final answer

The old AI agent was **not hallucinating**. It found several issues that remain true. It also mixed those with unmeasured future risks and design decisions. The correct conclusion is:

```text
Recent repairs fixed the immediate Stage -1 regressions and current automated suites pass.
The old report's long-term risks are still materially valid.
The system is improved, but not yet proven as a ten-year, arbitrary-scale production ERP.
```
