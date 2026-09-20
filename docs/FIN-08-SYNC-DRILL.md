# FIN-08 — Behavioural multi-device sync proof

## Status: FIXED (blocking CI)

The multi-device sync drill (`backend/scripts/verify-sync-multidevice.mjs`) is the
code-level behavioural proof for offline write → reconnect → converge, conflict,
cursor ties, device exclusion, stranded `pushing`, and hub 401 retry.

### What was wrong

Scenarios S0–S8 shared one HUB/A/B database trio for the whole run. Leftover
parties, inbox rows, claims, and notifications leaked across scenarios, so the
same commit scored differently (e.g. 27/33, 21/33, 17/33). The job could not be
a reliable regression gate.

### Fix

1. **Per-scenario isolation** — `resetTopology()` stops the three processes,
   re-clones `sync_hub` / `sync_dev_a` / `sync_dev_b` from the migrated
   `sync_tpl` template, re-seeds, and restarts. Called before each scenario
   group (S0–S2 stay on one topology; S3…S8 each get a fresh clone).
2. **Blocking CI** — `.github/workflows/ci.yml` job `sync-multidevice` runs
   `npm run test:sync-multidevice` with Postgres 16. No `continue-on-error`.
3. **Gate test** — `desktop/scripts/dfp008-ci-gates.test.mjs` asserts the job
   exists and is not advisory.

### Local run

```bash
cd backend
# Postgres on localhost:5432 user/password postgres
npm run test:sync-multidevice
```

### Still external (not FIN-08)

Two real machines on a network (DFP-023 hardware), packaged installer lifecycle
(DFP-004 / 020 / 021), hosted control-plane (DFP-024), brand icon (DFP-027),
and physical print certification remain outside this repo proof.
