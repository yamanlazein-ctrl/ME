@echo off
rem build-windows.cmd — portable desktop build entry (Plan §7: single installer).
rem
rem Replaces the old machine-specific build_desktop.bat (hardcoded VsDevCmd
rem path, hardcoded cargo/wix paths, hardcoded repo path). This script is
rem repo-relative and uses only tools on PATH, so it runs on any build
rem machine — including a clean packaging VM with no developer profile.
rem
rem Prerequisites on the build machine only (never on customer machines):
rem   - Rust stable (rustup) + x86_64-pc-windows-msvc target
rem   - Node.js 22+
rem   - Visual Studio Build Tools (C++ workload) — on PATH via "x64 Native
rem     Tools Command Prompt", NOT via a hardcoded VsDevCmd path here.
rem
rem Usage (from an x64 Native Tools prompt):
rem   cd desktop
rem   build-windows.cmd        (full MSI+NSIS via tauri:build)
rem
rem Final MSI/NSIS verification is manual per DEV-WORKFLOW.md — MSI is built
rem only on explicit approval, never for routine testing.
cd /d "%~dp0"
if errorlevel 1 exit /b 1

where cargo >nul 2>&1
if errorlevel 1 (
  echo [build] ERROR: cargo not on PATH. Install Rust via rustup first.
  exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
  echo [build] ERROR: npm not on PATH. Install Node.js 22+ first.
  exit /b 1
)

echo [build] starting tauri build at %TIME%
call npm run tauri:build
echo [build] tauri build exit=%ERRORLEVEL% at %TIME%
exit /b %ERRORLEVEL%
