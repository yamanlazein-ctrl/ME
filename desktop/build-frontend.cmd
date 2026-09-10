@echo off
rem ----------------------------------------------------------------------------
rem build-frontend.cmd - frontend build hook for the Tauri desktop package.
rem Invoked by tauri.conf.json beforeBuildCommand (which runs it via cmd with
rem the cwd wherever tauri build was started, so we hard-cd to the repo root).
rem
rem Why a script instead of an inline set X=Y && ... chain in tauri.conf.json:
rem   1. Embedded quotes inside the hook string get mangled by cmd's /C quote
rem      stripping rules - VITE_DESKTOP_DEPLOY silently never reached Vite and
rem      the app shipped with isDesktopPreBaked=false.
rem   2. set VAR=value && next (unquoted) leaves a trailing space in the value.
rem   3. robocopy's success exit code (1 = files copied) would abort the tauri
rem      build; here we normalize it explicitly.
rem ----------------------------------------------------------------------------
cd /d "%~dp0.."
if errorlevel 1 exit /b 1

rem Desktop pre-baked mode: license baked in the bundled DB, API on localhost.
set "VITE_DESKTOP_DEPLOY=true"
set "VITE_API_BASE_URL=http://127.0.0.1:8080"
set "VITE_DEFAULT_TENANT_ID=407fccfc-ba89-41c5-b5b9-ddb2c4f385d9"

call npm run build
if errorlevel 1 exit /b 1

rem Splash screen for the desktop boot (shown instantly while postgres/node
rem start in the background). Plain static file loaded by the "splash" Tauri
rem window (tauri.conf.json) via window URL "splash.html" relative to
rem frontendDist (this dist/ dir). Copied BEFORE the robocopy below.
copy /y "%~dp0splash.html" "dist\splash.html"
if errorlevel 1 exit /b 1

rem Mirror the fresh build into the bundled SSR resources. /MIR removes stale
rem hashed chunks from earlier builds (they accumulated as "extras" before).
robocopy dist desktop\src-tauri\resources\ssr\dist /MIR /R:1 /W:1 /NFL /NDL /NJH
rem robocopy exit codes >= 8 are real failures; 0-7 mean "copied/skipped" (ok).
if errorlevel 8 exit /b 1

rem P1: drop ALL source maps from the MSI payload (InstallerFiles count/size).
rem Maps are not needed at runtime — including those inside bundled node_modules.
del /s /q "desktop\src-tauri\resources\*.map" >nul 2>&1

exit /b 0
