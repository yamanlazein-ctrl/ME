@echo off
rem before-build.cmd - wrapper invoked by tauri.conf.json beforeBuildCommand.
rem Uses %~dp0 (directory of this script itself) so the build works regardless
rem of where `tauri build` is invoked from and without an absolute user path.
cd /d "%~dp0"

rem Portable Node runtime (runs the one local server on the customer's machine).
node "%~dp0..\scripts\stage-node-runtime.mjs"
if errorlevel 1 exit /b 1

rem Drop the unused parts of the bundled PostgreSQL (translations, docs, a duplicate share tree).
node "%~dp0..\scripts\prune-postgres.mjs"
if errorlevel 1 exit /b 1

rem Single-page frontend -> resources\server\web
call "%~dp0..\build-frontend.cmd"
if errorlevel 1 exit /b 1

rem Backend as a handful of files (esbuild bundle) -> resources\server. Rebuilt from source on every
rem run, so a stale backend can never ship. (The old package shipped ~19k backend node_modules files
rem plus ~10k SSR files: that is what made installation take 10+ minutes.)
node "%~dp0..\scripts\bundle-server.mjs"
if errorlevel 1 exit /b 1

rem CLEAN DATABASE TEMPLATE (always rebuilt, never reused): fresh initdb, ALL migrations, seed
rem company + admin only, bake the signed license, clean pg_ctl stop, install as
rem resources\postgres\pgdata-template. Needs DESKTOP_ADMIN_PASSWORD (+ the license signing key in
rem the environment or backend\.env). Fails loudly when missing so an installer is never built on an
rem old or dirty template.
node "%~dp0..\scripts\build-pgdata-template.mjs"
if errorlevel 1 exit /b 1

rem Independent hard gate on the template that will really be packaged: fully migrated, only
rem company + admin + license rows, document_sequences empty, cleanly shut down.
node "%~dp0..\scripts\verify-pgdata-template.mjs"
if errorlevel 1 exit /b 1

rem Real end-to-end gate of the packaged runtime: boots the bundled server on a free port (with 8080 and
rem 4173 deliberately occupied) against a copy of the template and checks API + UI on one origin.
node --test "%~dp0..\scripts\server-bundle.test.mjs"
if errorlevel 1 exit /b 1

rem DFP-001 hard release gate: every preflight_check path + packaging peers.
node "%~dp0..\scripts\validate-resource-manifest.mjs"
if errorlevel 1 exit /b 1
