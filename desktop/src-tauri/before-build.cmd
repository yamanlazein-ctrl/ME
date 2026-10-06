@echo off
rem before-build.cmd - wrapper invoked by tauri.conf.json beforeBuildCommand.
rem Uses %~dp0 (directory of this script itself) so the build works regardless
rem of where `tauri build` is invoked from and without an absolute user path.
rem
rem The desktop runs embedded SQLite (specs/001-desktop-sqlite-engine US2): no PostgreSQL binaries,
rem no database template and no database port are packaged. The database is created on the
rem customer's first launch from the bundled SQLite migrations + desktop-seed.json.
cd /d "%~dp0"

rem Portable Node runtime (runs the one local server on the customer's machine).
node "%~dp0..\scripts\stage-node-runtime.mjs"
if errorlevel 1 exit /b 1

rem Single-page frontend -> resources\server\web
call "%~dp0..\build-frontend.cmd"
if errorlevel 1 exit /b 1

rem Backend as a handful of files (esbuild bundle) + the better-sqlite3 addon + the SQLite migrations
rem -> resources\server. Rebuilt from source on every run, so a stale backend can never ship.
node "%~dp0..\scripts\bundle-server.mjs"
if errorlevel 1 exit /b 1

rem First-run content: the default tenant + the signed licence (no users — the customer's first launch
rem runs the onboarding that creates the owner). Only the licence signing key is required
rem (environment or backend\.env); the shipped public key must be its pair.
node "%~dp0..\scripts\build-desktop-seed.mjs"
if errorlevel 1 exit /b 1

rem Real end-to-end gate of the packaged runtime: the bundled node.exe boots the bundled server on
rem SQLite from a FRESH data root (with the desktop seed) and checks the API answers.
node --test "%~dp0..\scripts\server-bundle.test.mjs"
if errorlevel 1 exit /b 1

rem DFP-001 hard release gate: every preflight_check path, the bundled SQLite engine loads with the
rem bundled node.exe, and no PostgreSQL artefact is present.
node "%~dp0..\scripts\validate-resource-manifest.mjs"
if errorlevel 1 exit /b 1

rem SC-002: no PostgreSQL binary, template, client library or port file anywhere in the package.
node "%~dp0..\scripts\verify-no-postgres.mjs" "%~dp0resources"
if errorlevel 1 exit /b 1

rem Freshness gate: the packaged backend/UI must be NEWER than every source file and internally
rem consistent, so a stale tree fails the build instead of shipping.
node "%~dp0..\scripts\verify-build-freshness.mjs" pre
if errorlevel 1 exit /b 1
