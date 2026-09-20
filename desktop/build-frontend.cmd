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

rem Desktop pre-baked mode: license baked in the bundled DB.
rem API base is empty → same-origin SSR proxy (runtime-config / SSR_API_PROXY).
set "VITE_DESKTOP_DEPLOY=true"
set "VITE_API_BASE_URL="
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

rem DFP-001: checked-in SSR launcher (source of truth: desktop/ssr/serve.mjs).
rem before-build also runs stage-ssr.mjs; this copy keeps a partial frontend-only
rem rebuild self-bootable for local probes.
if not exist "desktop\src-tauri\resources\ssr" mkdir "desktop\src-tauri\resources\ssr"
copy /y "desktop\ssr\serve.mjs" "desktop\src-tauri\resources\ssr\serve.mjs"
if errorlevel 1 exit /b 1
copy /y "desktop\ssr\resolve-api-proxy.mjs" "desktop\src-tauri\resources\ssr\resolve-api-proxy.mjs"
if errorlevel 1 exit /b 1
copy /y "desktop\scripts\resource-manifest.json" "desktop\src-tauri\resources\resource-manifest.json"
if errorlevel 1 exit /b 1

rem DFP-036: source maps are stripped from the customer MSI by default.
rem Keep a private copy under resources/_symbols for support/symbolication.
rem Set ME_KEEP_SOURCEMAPS=1 to leave maps inside the packaged tree (dev only).
if /I not "%ME_KEEP_SOURCEMAPS%"=="1" (
  if not exist "desktop\src-tauri\resources\_symbols" mkdir "desktop\src-tauri\resources\_symbols"
  robocopy "desktop\src-tauri\resources" "desktop\src-tauri\resources\_symbols" *.map /S /R:1 /W:1 /NFL /NDL /NJH /NJS >nul
  del /s /q "desktop\src-tauri\resources\*.map" >nul 2>&1
  rem Never ship the private symbol store inside the installer payload.
  if exist "desktop\src-tauri\resources\_symbols" (
    rem _symbols stays on the build machine / CI artifact, not under Tauri resources that are bundled —
    rem move it beside the build output instead of inside resources/.
    if not exist "desktop\src-tauri\target\symbols" mkdir "desktop\src-tauri\target\symbols"
    robocopy "desktop\src-tauri\resources\_symbols" "desktop\src-tauri\target\symbols" /E /MOVE /R:1 /W:1 /NFL /NDL /NJH /NJS >nul
  )
)
exit /b 0
