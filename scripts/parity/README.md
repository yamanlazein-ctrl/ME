# Parity harness (PostgreSQL reference ↔ SQLite desktop)

Proves AC-3 / SC-001 for `specs/001-desktop-sqlite-engine`: the same scripted scenarios, run
against the frozen PostgreSQL reference build and against the SQLite build from clean states,
must produce an **empty diff**.

## Run order

1. `node scripts/parity/run.mjs --engine postgres --base-url <url-or-pipe> --out scripts/parity/baseline/ref/`
   against the frozen reference build (`scripts/parity/baseline/REFERENCE.md`).
2. `node scripts/parity/run.mjs --engine sqlite --base-url <url-or-pipe> --out scripts/parity/out/sut/`
   against the SQLite build.
3. `node scripts/parity/diff.mjs scripts/parity/baseline/ref/ scripts/parity/out/sut/`
   exits non-zero on any difference.

## Layout

- `scenarios/`: one module per domain, driving the HTTP API only (tasks T050).
- `run.mjs`: runs the scenarios and writes canonical exports (tasks T051).
- `diff.mjs`: compares two export directories file by file, value by value.
- `baseline/`: committed reference outputs, the reference build hash and the completeness baseline.
- `reports/`: PASS/FAIL reports per user story and release gate.
