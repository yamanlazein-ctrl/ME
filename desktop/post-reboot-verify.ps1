# Post-reboot activation persistence check for Motard ERP desktop.
# Writes result to %LOCALAPPDATA%\motard-erp\post-reboot-verify.txt
$out = Join-Path $env:LOCALAPPDATA 'motard-erp\post-reboot-verify.txt'
$lines = @()
$lines += "verified_at=$(Get-Date -Format o)"
$lines += "computer=$env:COMPUTERNAME"

$appData = Join-Path $env:LOCALAPPDATA 'motard-erp'
$binding = Join-Path $appData 'device-binding.dat'
$secrets = Join-Path $appData 'secrets.dat'
$pg = Join-Path $appData 'pgdata\PG_VERSION'
$lines += "device_binding=$(Test-Path $binding)"
$lines += "secrets=$(Test-Path $secrets)"
$lines += "pgdata=$(Test-Path $pg)"

$ls = Join-Path $env:LOCALAPPDATA 'com.motardfabrics.erp\EBWebView\Default\Local Storage\leveldb'
$hit = $false
if (Test-Path $ls) {
  Get-ChildItem $ls -File -EA SilentlyContinue | ForEach-Object {
    try {
      $t = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($_.FullName))
      if ($t -match 'erp\.license') { $hit = $true }
    } catch {}
  }
}
$lines += "webview_erp_license_hit=$hit"

$pf = 'C:\Program Files\Motard Fabrics Group ERP'
$exe = Get-ChildItem $pf -Recurse -Filter '*.exe' -EA SilentlyContinue | Select-Object -First 3 -ExpandProperty FullName
$lines += "install_dir_exists=$(Test-Path $pf)"
$lines += "exe_found=$([bool]$exe)"
if ($exe) { $lines += "exe=$($exe -join '|')" }

# PASS if binding + (license LS hit OR secrets) — FE gate needs LS; shell needs binding
$pass = (Test-Path $binding) -and ($hit -or (Test-Path $secrets))
$lines += "verdict=$(if ($pass) { 'PASS_MARKERS_PRESENT' } else { 'FAIL_MISSING_MARKERS' })"
$lines += "note=Markers present implies ActivationGate should not re-ask key; manual UI confirm still recommended."

New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
Set-Content -Path $out -Value ($lines -join "`r`n") -Encoding UTF8
