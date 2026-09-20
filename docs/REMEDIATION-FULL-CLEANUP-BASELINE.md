# remediation/full-cleanup — baseline

Branch: `remediation/full-cleanup` @ `ba395a8b`  
Recorded: 2026-09-20T20:15:13+03:00

## Commands (as requested)

| Gate | Exit | Duration | Notes |
|------|------|----------|-------|
| `npm run typecheck` | **2** | ~21s | `loginIfNeeded` missing from `tests/e2e/_helpers/login` (cert-* specs) |
| `npm run test` | **1** | ~15s | 2 failures: `blankFirstPage` timeout; `auth-context` empty tenantId |
| `npm run lint` | **1** | ~56s | ~7879 prettier/eslint issues (mostly e2e) |
| `npm run build` | **1** | ~9s | Can't resolve `@fontsource/ibm-plex-sans-arabic/400.css` |

## Intent

Bring all four gates green, then execute Phases 1–8 on this branch. Do not edit old migrations; add new ones when schema changes are required.
