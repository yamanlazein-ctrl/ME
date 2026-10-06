@echo off
rem ----------------------------------------------------------------------------
rem build-release.cmd — the ONLY supported way to produce a customer installer.
rem
rem It exists because `npx tauri build` on its own cannot tell you whether the
rem artifact you are about to ship is the artifact you just built. Two copies of
rem the packaged resources live side by side after a build — `resources\` (what
rem tauri bundles) and `target\release\` (what the executable loads at runtime) —
rem and the executable additionally EMBEDS the web bundle as of compile time. A
rem partially-rebuilt tree leaves all three disagreeing, and the symptom is a
rem customer running "the new build" and seeing the old behaviour.
rem
rem `tauri build` runs before-build.cmd (regenerates resources, prunes PostgreSQL,
rem rebuilds the database template, runs the end-to-end gate and the freshness
rem gate) and only then compiles. This wrapper adds the missing half: after the
rem bundle exists, prove the runtime copies match resources byte-for-byte, that
rem the executable embeds the CURRENT web assets, and that a setup installer was
rem produced and is newer than the executable.
rem
rem Usage:  npm run tauri:release        (from desktop\)
rem         desktop\scripts\build-release.cmd
rem ----------------------------------------------------------------------------
cd /d "%~dp0\.."
if errorlevel 1 exit /b 1

call npm run tauri:build
if errorlevel 1 exit /b 1

node "scripts\verify-build-freshness.mjs" post release
if errorlevel 1 exit /b 1

echo.
echo [build-release] DONE — the installer under src-tauri\target\release\bundle\nsis
echo [build-release] is byte-verified against src-tauri\resources.
exit /b 0
