@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64
if errorlevel 1 (
  echo [build] VsDevCmd failed
  exit /b 1
)
set PATH=%PATH%;C:\Users\Taw\.cargo\bin;C:\Users\Taw\AppData\Local\Temp\wixdl\wix
echo [build] PATH has cargo=%PATH:*.cargo=cargo%
cd /d C:\Users\Taw\Downloads\Compressed\q\ME-main\desktop
echo [build] starting tauri build at %TIME%
npm run tauri:build
echo [build] tauri build exit=%ERRORLEVEL% at %TIME%
