# Durability (SC-004) — T114 done, T115 open (VM-only)

## T114 — hard-kill loop on the SQLite build (2026-10-05, developer machine)

Command: `node backend/scripts/durability-proof.mjs --engine sqlite --rounds 25` (implemented in
`backend/scripts/durability-sqlite-crash.mjs`). It runs a real backend with `DB_ENGINE=sqlite` on a fresh company
file, in non-desktop mode.

Each save is a paid sale invoice: invoice, lines, ledger legs, cash and stock movement, in one transaction. The
reference shape is 1 line, 4 ledger legs and 1 stock movement. Saves run back to back. At a random moment between
0.3 and 1.8 s the backend is killed with `taskkill /T /F` (no shutdown, no checkpoint). The file is then opened raw
and checked, and the backend restarts on it (REUSE) for the next round.

**Result: 25/25 rounds PASS.**

| Check (every round) | Result |
|---|---|
| `PRAGMA integrity_check` | `ok` 25/25 |
| `PRAGMA foreign_key_check` | empty 25/25 |
| every save confirmed to the client (HTTP 201) present | 737/737 confirmed saves present |
| every invoice in the file complete (same row shape as the reference sale) or absent | 0 incomplete of 755 |

The file holds 18 more invoices than the client saw confirmed, about one per round. Each is a save that committed
just before the kill, whose response was lost with the process. All 18 are complete, which is exactly the
"complete or absent" rule. Machine-readable report: `scripts/parity/out/durability-sqlite/report.json`.

## T115 — VM power loss: **not run**

T115 needs a Windows 10 22H2 x64 VM and a Windows 11 x64 VM, each hard-reset at least 20 times during the T114
loop. No VM is available in this environment. T115 is the only way to prove that the OS and disk flush behave
correctly under real power loss (`synchronous = FULL` + WAL); a process kill cannot. Run the T114 command inside each
VM and hard-reset the VM instead of killing the process.
