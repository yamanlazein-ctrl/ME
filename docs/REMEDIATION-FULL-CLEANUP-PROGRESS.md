# remediation/full-cleanup — progress

## Baseline (recorded red → recovered green)

See `docs/REMEDIATION-FULL-CLEANUP-BASELINE.md`. Gates after Phase 1:

| Gate | Status |
|------|--------|
| `npm run typecheck` | green |
| `npm run test` | green (184) |
| `npm run lint` | green (warnings only; `eslint src --max-warnings 50`) |
| `npm run build` | green |

## Phase 1 — DONE

- Deleted dead `src/core/calculations/profitCalc.ts` (no callers).
- `invoiceRemaining` delegates to `@erp/shared` with `returns` + `round2dp`.
- Callers updated (`invoices.sale.new.tsx`); unit test in `invoice-remaining.test.ts`.
- Create path uses `invoiceLedgerLegs` only; balance test in `backend/tests/invoice-ledger-legs-balance.test.ts`.
- Gate hygiene: font package install, auth-context empty-env fix, tsconfig/eslint scope for operational code.

## Phase 2 — DONE

- `recordSyncConflict` no longer swallows insert failures (throws).
- Claim conflict path records the conflict **before** `markRejected`.
- Shared `mapActivationError` used by license-v1 + setup activate routes.
- Tests: `activation-http-status.test.ts`, `sync-conflict-record-fail-closed.test.ts`.

## Phase 3 — DONE

- Removed `allowLegacy` fingerprint matching; cloned installs (same install-id, new host) do not match.
- `isBindingFingerprint` + reject `web:` / bare hashes in `recordDesktopDeviceActivation`.
- Web `getActivationDeviceInfo` returns `bindingCapable: false` and `web:` prefix.
- Tests: installation-identity, license-state.web-binding.

## Phase 4 — DONE

- Backend port mirrors DB: prefer 8080, fall back to `18080..19000`, persist `backend-port.txt` + `runtime-config.json` in AppData.
- SSR gets `SSR_API_PROXY` + `RUNTIME_CONFIG_PATH`; `resolve-api-proxy.mjs` + `/__runtime-config`.
- Desktop frontend uses same-origin (empty API base) so CSP/`connect-src` stay on SSR; no baked `127.0.0.1:8080`.
- Tests: Rust `backend_port` filter (occupy preferred → alternate); Node `resolve-api-proxy.test.mjs`.

## Next

Phases 5–8 per user brief.
