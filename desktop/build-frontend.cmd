@echo off
rem ----------------------------------------------------------------------------
rem build-frontend.cmd - builds the single-page frontend for the desktop package.
rem
rem The desktop no longer runs an SSR server: the local backend serves this static build on the
rem same origin as the API (see backend/src/presentation/staticApp.ts). Output is mirrored into
rem desktop\src-tauri\resources\server\web (bundle-server.mjs keeps that folder when it rebuilds
rem the rest of resources\server).
rem
rem Why a script instead of an inline set X=Y && ... chain in tauri.conf.json: embedded quotes are
rem mangled by cmd /C quote stripping, and `set VAR=value && next` leaves a trailing space.
rem ----------------------------------------------------------------------------
cd /d "%~dp0.."
if errorlevel 1 exit /b 1

rem Desktop mode: SPA build (no SSR), license baked in the bundled DB, API on the same origin.
set "VITE_DESKTOP_DEPLOY=true"
set "VITE_API_BASE_URL="
set "VITE_DEFAULT_TENANT_ID=407fccfc-ba89-41c5-b5b9-ddb2c4f385d9"

call npm run build
if errorlevel 1 exit /b 1

if not exist "dist\client\_shell.html" (
  echo ERROR: dist\client\_shell.html is missing - the SPA shell was not produced.
  exit /b 1
)

rem Mirror the fresh SPA build. /MIR removes stale hashed chunks from earlier builds.
robocopy dist\client desktop\src-tauri\resources\server\web /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS >nul
rem robocopy exit codes >= 8 are real failures; 0-7 mean "copied/skipped" (ok).
if errorlevel 8 exit /b 1

rem DFP-036: source maps never ship to customers. Scope: ONLY the web tree. (An unscoped glob over
rem resources\*.map once also deleted PostgreSQL's own pg_filenode.map catalog files from the database
rem template - see build-frontend-scope.test.mjs.) Set ME_KEEP_SOURCEMAPS=1 to keep them (dev only).
if /I not "%ME_KEEP_SOURCEMAPS%"=="1" (
  if not exist "desktop\src-tauri\target\symbols" mkdir "desktop\src-tauri\target\symbols"
  robocopy "desktop\src-tauri\resources\server\web" "desktop\src-tauri\target\symbols" *.map /S /R:1 /W:1 /NFL /NDL /NJH /NJS >nul
  del /s /q "desktop\src-tauri\resources\server\web\*.map" >nul 2>&1
)
exit /b 0
