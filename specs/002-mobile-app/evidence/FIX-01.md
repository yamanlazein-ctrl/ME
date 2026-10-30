# FIX-01 — why Home said «تعذّر تحميل البيانات»

**Root cause (found by reading the code path; confirmed by the emulator job FIX-05 on the fixed build):**
`openRuntime()` (mobile/src/core/runtime.ts) registers the desktop's `motard_*` SQL functions through
`registerNumericFunctions(conn)`. On the phone `conn` is the op-sqlite shim, whose `function()` / `aggregate()` threw
`UDF_UNSUPPORTED` (S1-4 — op-sqlite 18 has no UDF API; T044 had been skipped on purpose). The throw happened inside
`getApp()`'s first boot, so `getApp()` rejected for every caller: the route guard never got its answer and Home's
dashboard query failed. The screen printed one generic sentence and discarded the error.

**Why it was invisible:** `useBoot` and `useDashboard` had no catch/log. Fixed: `src/core/devlog.ts` (`logError` →
`console.error("MOTARD_ERR [scope] …")`, grep-able with `adb logcat | grep MOTARD_ERR`), `useBoot` reports `bootError`
(shown by the root layout with testID `boot-error-detail`), Home prints `error.message` (testID `home-error`).
The emulator job fails on any `MOTARD_ERR` line or any of these texts.

**Fix:** FIX-02 (native UDF support).
