# FIX-02 — T044 done: SQL functions and 64-bit integers on the phone

op-sqlite 18.2.5 has no user-defined-function API and returns every INTEGER as a double (S1-4 / S1-5). Fixed with
`mobile/patches/@op-engineering+op-sqlite+18.2.5.patch` (applied by `patch-package` in `postinstall`):

- `cpp/OPDatabase.cpp`: `db.createFunction(name, deterministic, fn)` and `db.createAggregate(name, {start, step, result})` over
  `sqlite3_create_function_v2`; arguments become JS values (INTEGER beyond ±2^53 → BigInt), results are converted back. The
  functions run on the JS thread inside the synchronous `execute*` calls (a call from the async thread pool is refused with an SQL
  error instead of touching the runtime). Because the desktop's own JavaScript functions (`motard_pgdiv`, `motard_dectext`,
  `motard_decsum`, `motard_re_substr`, `motard_re_match` in `numericFunctions.ts`) are registered unchanged, the answers are
  identical to the desktop's by construction - no C port of PostgreSQL's numeric division.
- `src/functions.ts` and `lib/module/functions.js`: expose `createFunction`/`createAggregate` through op-sqlite's JS wrapper (the
  wrapper copies a fixed list of members from the native object; the first CI run showed `UDF_UNSUPPORTED` again until this was added).
- `cpp/OPBridge.cpp`, `cpp/OPUtils.cpp`: INTEGER columns beyond ±2^53 come back as `long long` → BigInt; BigInt parameters bind with
  `sqlite3_bind_int64`.
- `src/platform/sqlite/BetterSqliteShim.ts`: `function()` / `aggregate()` call the native hooks (still `UDF_UNSUPPORTED` without the patch).

Checks: `test/unit/shim.test.ts` (functions through the shim give the desktop's results; a connection without the hooks reports
`UDF_UNSUPPORTED`); the emulator run (FIX-05) boots with `requireFunctions` on, enrols, downloads, signs in and shows Home with
no `MOTARD_ERR`. Parity (GATE-P) unchanged: 13 tests, 0 differences.
