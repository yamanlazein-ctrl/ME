# Release candidate (T116) — the single artifact for T117–T122

| | |
|---|---|
| File | `desktop/src-tauri/target/release/bundle/nsis/Motard Fabrics Group ERP_2.0.0_x64-setup.exe` |
| **sha256** | **`17ffe64785d573402d5d8db74254877e763b8e1b27ef3e257aaf08fd831e8025`** |
| Size | 31,463,363 bytes |
| Version | **2.0.0** (bumped from 1.2.0; see below) |
| Built | 2026-10-05, `npm run tauri:release` (exit 0) on branch `clean-desktop-release` (working tree; D-4 committed as `d8608ac3`, the rest uncommitted) |
| Gates in the build | Node staging, SPA, server bundle (234 files), desktop seed (licence key ↔ `license-public.pem` gate), `server-bundle.test.mjs` (7/7), resource manifest, `verify-no-postgres` (PASS), freshness pre and post (the exe embeds all current web assets; the installer was built from the current resources) |

**Version.** The PostgreSQL desktop shipped as 1.2.0. The SQLite build changes the data store and the backup format:
v2 PostgreSQL-era backups are refused. Shipping it under the same number would leave the in-app updater nothing newer
to offer, and would make the two builds indistinguishable. The version is set to **2.0.0** in `package.json`,
`desktop/package.json`, `desktop/src-tauri/tauri.conf.json` and `desktop/src-tauri/Cargo.toml`. The owner can change
it; changing it requires a rebuild and a new sha256.

**Built twice.** The first 2.0.0 build (`20caaf06…`) was superseded the same day. T122's coverage check found
`drizzle-orm/node-postgres/migrator` being evaluated in a SQLite process (a static import in `runDesktopMigrations.ts`,
now lazy). The installer above is the rebuild, and every later task uses exactly this file.

The installer is unsigned (SmartScreen will warn), as before.
