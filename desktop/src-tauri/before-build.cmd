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

call "%~dp0..\build-frontend.cmd"
