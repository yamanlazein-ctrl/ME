@echo off
rem before-build.cmd — wrapper invoked by tauri.conf.json beforeBuildCommand
rem Uses %~dp0 (directory of this script itself) so the build works regardless
rem of where `tauri build` is invoked from and without an absolute user path.
cd /d "%~dp0"

rem Issue 17: refuse to package leftover pgdata bak trees (thousands of files → slow MSI).
for /d %%D in ("resources\postgres\pgdata-template.bak*") do (
  echo ERROR: Refuse to package %%D — move it to desktop\_not_packaged\ first.
  exit /b 1
)

rem DFP-001: portable Node must exist before backend staging (and before SSR).
node "%~dp0..\scripts\stage-node-runtime.mjs"
if errorlevel 1 exit /b 1

call "%~dp0..\build-frontend.cmd"
if errorlevel 1 exit /b 1

rem DFP-001: copy checked-in desktop/ssr/serve.mjs into resources and assert
rem the SSR handler from build-frontend robocopy is present.
node "%~dp0..\scripts\stage-ssr.mjs"
if errorlevel 1 exit /b 1

rem Packaging parity (no stale backend ships): rebuild the backend from
rem source and mirror its exact runtime tree. Fails loudly when the
rem portable node.exe runtime has not been staged.
node "%~dp0..\scripts\stage-backend.mjs"
if errorlevel 1 exit /b 1

rem Packaging parity (FIX-PLAN 3.1 lesson): mirror the EXACT resolved SSR
rem runtime deps from root node_modules — never `npm install` with caret
rem ranges here (that once shipped a newer router-core than the inlined
rem start-server-core expected: "matchedRoutes is not iterable" at customer
rem runtime only). Fails the build loudly on any unresolvable external.
node "%~dp0..\scripts\sync-ssr-deps.mjs"
if errorlevel 1 exit /b 1

rem DFP-001 hard release gate: every preflight_check path + packaging peers.
node "%~dp0..\scripts\validate-resource-manifest.mjs"
if errorlevel 1 exit /b 1
