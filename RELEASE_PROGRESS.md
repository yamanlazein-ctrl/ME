# Release progress (resume checkpoint)

Mission: clean-slate desktop rebuild + verification + customer release (2026-10-13).
Resume from the first item that is not DONE.

## Phase 1 — inventory: DONE
Repo on `main` at HEAD `a3882558`; about 176 uncommitted entries (rounds 6–8), all kept. Render is BLOCKED:
the MCP server gives `CONNECT_TIMEOUT` and the API answers 401 because there is no key.

## Phase 2 — remove the old desktop: DONE (approved by the owner 2026-10-13)
- Checked before deleting: the safety patch's 138 non-desktop files still differ in the tree.
- Kept: `desktop-app/src-tauri/resources/license-public.pem` (it pairs with `LICENSE_SIGNING_KEY` in
  `backend/.env`) and the PostgreSQL test binaries in `tools/postgres-test/` (git-ignored).
- Deleted: `desktop/`, `%LOCALAPPDATA%\motard-erp`, `motard-erp-dev`, `%USERPROFILE%\MotardRelease-Safety\`.
  The old updater signing key is gone, so v3 has a new identity (`com.motardfabrics.erp3`).

## Phase 3 — new shell `desktop-app/`: DONE
Installer `Motard ERP_3.0.0_x64-setup.exe` (sha256 `49B6E6E9…BCB1B`) built and lifecycle-tested on
isolated data roots: install, restart, update with verified pre-update copy, failed migration,
re-install, uninstall + install, crash, corrupt keys. See CUSTOMER_RELEASE_READINESS_REPORT.md.

## Phase 4 — verification: DONE
Frontend 425/425; backend SQLite 995 passed; backend PostgreSQL 1042/1042; cargo test 19/19; tsc and
typecheck:sqlite clean. Invitation creation is admin-only.

## Phase 5 — reports: DONE
CUSTOMER_RELEASE_READINESS_REPORT.md, FINAL_REMEDIATION_LOG.md.

## NEXT (needs the owner or other hardware)
1. Clean Windows VM run of the installer.
2. A real Windows restart test.
3. Code-signing certificate.
4. Render hub access (API key) for the sync re-test.
5. Decide `BAKED_LICENSE_DEVICES`.
6. Commit, including `desktop-app/release-identity.json`.
