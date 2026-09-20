# Dev / diagnostic scripts

Temporary QA probes and one-off verifiers moved out of `backend/scripts/`
so packaging and CI keep only production-facing entrypoints.

Not wired into `package.json` or GitHub Actions. Run explicitly, e.g.:

```bash
node tools/dev/qa-db-probe.mjs
node tools/dev/phase8-runtime-e2e.mjs
```

Canonical sync drills remain under `backend/scripts/` (`verify-sync-multidevice.mjs`, `verify-restore-sync-state.mjs`, `verify-rls.mjs`).
