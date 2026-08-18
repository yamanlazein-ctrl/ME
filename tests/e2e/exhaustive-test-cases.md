# Exhaustive Full-System Test Plan — Case Register (STAGE 0)

Methodology: Boundary Value Analysis + Edge/Exploratory + Property-Based Invariant + Combinatorial/Stress/Chaos.

## Invariants (must always hold, zero exceptions)
- I1 — per-entry double-entry balance (Σsigned = 0 per journal entry)
- I2 — conservation (no value/quantity appears or vanishes)
- I3 — idempotency (duplicate request ⇒ one operation)
- I4 — no floating-point drift (exact money)
- I5 — replay consistency (recompute balances == stored balances)
- I6 — no live financial number without a journaled entry
- I7 — currency isolation (no SYP/USD mixing)
- I8 — color/item isolation
- I9 — no silent quantity loss (waste documented)
- I10 — no negative stock

## STAGE 1 — Boundary + Edge (deterministic)
1.  INV.BC.01  Sell exactly available qty → remaining 0, status exhausted
2.  INV.BC.02  Sell available + 0.001 → rejected (422)
3.  INV.BC.03  Sell 0 kg → rejected
4.  INV.BC.04  Sell negative kg → rejected
5.  INV.BC.05  Roll create initialKg 0 → rejected
6.  INV.ED.01  Print send ALL available stock → remaining 0
7.  INV.ED.02  Cancel sale then partial return on it
8.  CB.BC.01   Opening balance 0
9.  CB.BC.02   Expense > cashbox balance (does it go negative or reject?)
10. CB.ED.01   Receipt + payment same moment, same amount, two parties
11. CB.ED.02   Partial payment in two currencies on same invoice (I7)
12. INV.BC.06  Invoice 0.001 kg line
13. INV.ED.01  Cancel invoice after partial receipt voucher
14. PR.BC.01   Print over-receive (receivedKg > sent) → rejected
15. PR.ED.01   Print send then cancel original invoice before receive
16. RT.BC.01   Return full invoice quantity
17. RT.BC.02   Return > sold quantity → rejected
18. RT.ED.01   Two returns on same invoice exceeding original qty → rejected

## STAGE 2 — Invariant (property-based, random)
19. I1.GEN.01  40 random mixed transactions → every entry Σdebit=Σcredit
20. I2.GEN.01  Quantity conservation across 30 random ops
21. I3.GEN.01  Duplicate invoice POST (same Idempotency-Key) → 1 invoice
22. I3.GEN.02  Duplicate receipt POST (same Idempotency-Key) → 1 voucher
23. I4.GEN.01  300 sequential ops → no drift, exact integer balances
24. I5.GEN.01  Replay party balance from raw ledger == API balance
25. I6.GEN.01  Dashboard profit == ledger revenue − COGS
26. I7.GEN.01  SYP vs USD balance isolation
27. I8.GEN.01  30 random color sales → strict per-color isolation
28. I9.GEN.01  Print waste documented (sent−received)
29. I10.GEN.01 20 random over-sell attempts → all rejected, no negative stock

## STAGE 3 — Chaos + Concurrency
30. CC.01  Concurrent sales on same roll → stock never negative, exact total
31. CC.02  Concurrent duplicate receipt (same key) → single voucher
32. CC.03  Concurrent mixed ops on same customer → balance consistent
33. LD.01  300-op load — record latency, check for degradation

## STAGE 4 — Replay
34. RP.01  Replay all party balances from ledger == API (I5 full)
