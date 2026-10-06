# PostgreSQL reference build (parity oracle) — task T026

| Field | Value |
|---|---|
| Installer | `Motard Fabrics Group ERP_1.2.0_x64-setup.exe` |
| sha256 | `4e9fb793679df782722ee142f9748b175708d1dc2df9c5f37ca5c1101ca2549f` |
| Size | 53588544 bytes |
| App version | 1.2.0 |
| Built | 2026-10-03 18:50 via `npm run tauri:release` (freshness gates passed) |
| Source | git HEAD `7d2ffd1fbafaa6da93c887ab3b80bcd464ed86c7` + uncommitted working tree (sha256 of `git diff HEAD`: `e5522524ca7553f30505b06b95a630201da70d61915e639e724143c906f1a30e`) |
| Includes | D-4 cancelled-party fix (T018–T020), track P: no statement / fetch-all page caps (T022–T023), D-3 list-load error + Retry (T024) |
| Engine | PostgreSQL 17 (bundled), desktop runtime unchanged |

This exact file is the AC-3 parity oracle for the rest of the feature. Keep it unmodified; do not
rebuild it. (No commit was created — commits require the owner's go-ahead.)

Preserved copy (outside the repo, survives rebuilds): `C:\Users\Taw\Downloads\Compressed\q\motard-reference\reference-pg-1.2.0-setup.exe` (same sha256).
