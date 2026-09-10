@echo off
setlocal EnableDelayedExpansion
rem Timed clean desktop MSI build — stages logged to build-timing.log
cd /d "%~dp0"

set "LOG=%~dp0build-timing.log"
echo ==== Motard desktop timed build %DATE% %TIME% ==== > "%LOG%"

call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64
if errorlevel 1 (
  echo [FAIL] VsDevCmd >> "%LOG%"
  exit /b 1
)
set "PATH=%PATH%;C:\Users\Taw\.cargo\bin;C:\Users\Taw\AppData\Local\Temp\wixdl\wix"

echo [1] backend tsc start %TIME% >> "%LOG%"
set "T1=%TIME%"
cd /d "%~dp0..\backend"
call npm run build
if errorlevel 1 (
  echo [FAIL] backend build >> "%LOG%"
  exit /b 1
)
echo [1] backend tsc end %TIME% >> "%LOG%"

echo [2] sync backend dist start %TIME% >> "%LOG%"
cd /d "%~dp0.."
robocopy backend\dist desktop\src-tauri\resources\backend\dist /MIR /R:1 /W:1 /NFL /NDL /NJH
if errorlevel 8 (
  echo [FAIL] robocopy backend >> "%LOG%"
  exit /b 1
)
echo [2] sync backend dist end %TIME% >> "%LOG%"

echo [3] tauri build (includes beforeBuild frontend+mapsweep+cargo+wix) start %TIME% >> "%LOG%"
cd /d "%~dp0"
call npm run tauri:build
set "TB=%ERRORLEVEL%"
echo [3] tauri build end %TIME% exit=%TB% >> "%LOG%"
if not "%TB%"=="0" exit /b %TB%

echo [4] verify no maps in resources start %TIME% >> "%LOG%"
cd /d "%~dp0.."
powershell -NoProfile -Command "$c=(Get-ChildItem 'desktop\src-tauri\resources' -Recurse -Filter '*.map' -File -EA SilentlyContinue).Count; Add-Content -Path '%LOG%' -Value ('map_files_remaining=' + $c); if ($c -gt 0) { exit 2 }"
if errorlevel 1 (
  echo [FAIL] maps still present >> "%LOG%"
  exit /b 2
)
echo [4] verify maps end %TIME% >> "%LOG%"

echo [OK] build complete %TIME% >> "%LOG%"
dir /b "src-tauri\target\release\bundle\msi\*.msi" >> "%LOG%"
exit /b 0
