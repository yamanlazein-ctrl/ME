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

## Phase 5 — DONE

- New `cashbox_daily_balances` table + `cashbox_daily_apply_delta` / triggers on `ledger_entries` and `manual_movements`.
- `getCashboxBalanceAsOf` is O(1) from daily rows; `recomputeCashboxBalanceAsOf` kept for parity/fallback.
- Opening-balance edits shift all daily closings via `cashbox_daily_shift_all`.
- Tests: migration contract + live fast-path==recompute after 3200 movements (when DB reachable).

## Phase 6 — DONE

- Behavioral sync suites: `sync-behavioral-idempotency`, `sync-behavioral-pull-cursor`, `sync-behavioral-claims-fww` (Postgres when reachable).
- Hermetic self-seed/cleanup for session-cutoff, device-identity-link, sync-conflicts-resolve, sync-identity-claims.
- `audit-findings.test.ts` excluded from unit vitest unless `API_BASE` set; run via `test:integration` / `test:integration:audit`.
- `skipUnlessDatabase` for visible skips; `fileParallelism: false` for fixture isolation.

## Phase 7 — DONE

- `resource-manifest.json` v2 with sha256 for sealed SSR launcher files.
- `validate-resource-manifest.mjs` verifies digests; corruption test fails on flipped byte.
- Rust `preflight_check` verifies sha256 entries from staged `resources/resource-manifest.json`.

## Phase 8 — DONE

- Moved unreferenced `qa-*.mjs`, `phase8-runtime-e2e.mjs`, `verify-multicolor-fix.mjs`, `verify-sync-env.mjs` → `tools/dev/`.
- Archived `MOTARD-COMPLETE-REMEDIATION-PLAN.md` → `docs/archive/` (sync-invariants path updated).
- Deleted proven-unused: `LoginPage.tsx`, supabase client, `FabricCombobox`, `useFormValidation`, `stockAllocation.ts`.
- Knip: ignore design-system `src/components/ui/**` and `tools/**` (false positives).

## Branch status

`remediation/full-cleanup` — Phases 1–8 complete. Do not push unless requested.
