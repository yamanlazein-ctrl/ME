<#
.SYNOPSIS
  US3 negative lifecycle cases (specs/001-desktop-sqlite-engine T080) against an INSTALLED packaged build.

.DESCRIPTION
  Run on a disposable Windows 10/11 VM (or a test account) where Motard ERP is installed and has been
  launched once (onboarding done, some data entered). For each case the script:
    1. restores the baseline data root + HKCU marker,
    2. applies the mutation,
    3. hashes every protected file (data\, db-meta.json, backups.json, set-aside\),
    4. launches the app and waits for logs\startup.log to report STARTUP_STATE=<state>,
    5. stops the app WITHOUT choosing anything, hashes again and asserts nothing changed.

  Cases (contracts/data-root-and-startup-states.md):
    MISMATCH          another machine's data root copied in (-ForeignDataRoot), else db-meta.json data_id edited
    PRIOR_DATA_FOUND  device-binding.dat deleted
    PRIOR_DATA_FOUND  HKCU InstallInstanceId removed
    CORRUPT           motard.db truncated
    LOCKED_UNKNOWN    motard.lock held open (share mode none) by a foreign process (this PowerShell)
    DATA_MISSING      data\ deleted while db-meta.json remains

  The baseline is restored at the end. Nothing is uploaded anywhere.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\lifecycle\negative-cases.ps1 -Report scripts\parity\reports\US3-negative-cases.json
#>
param(
  [string]$Exe = (Join-Path $env:LOCALAPPDATA "Motard Fabrics Group ERP\motard-fabrics-erp.exe"),
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA "motard-erp"),
  [string]$ForeignDataRoot = "",
  [int]$TimeoutSec = 90,
  [string]$Report = ""
)
$ErrorActionPreference = "Stop"
$RegKey = "HKCU:\Software\MotardFabricsErp"
$Baseline = Join-Path $env:TEMP ("motard-neg-baseline-" + [guid]::NewGuid().ToString("N"))

if (-not (Test-Path $Exe)) { throw "Motard ERP executable not found: $Exe (pass -Exe)" }
if (-not (Test-Path (Join-Path $DataRoot "data\motard.db"))) { throw "No database at $DataRoot\data\motard.db - launch the app once first." }

function Stop-Motard {
  # the app and its bundled server (node.exe under the install dir)
  $installDir = Split-Path $Exe
  Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and (($_.ExecutablePath -ieq $Exe) -or
      ($_.Name -ieq "node.exe" -and $_.ExecutablePath.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase)))
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 1500
}

function Get-ProtectedHashes {
  $h = [ordered]@{}
  foreach ($rel in @("data", "db-meta.json", "backups.json", "set-aside")) {
    $p = Join-Path $DataRoot $rel
    if (-not (Test-Path $p)) { continue }
    # motard.db-shm is SQLite's shared-memory WAL index: derived from -wal, rebuilt on demand, never data.
    # A read-only inspection of a database whose WAL still holds pages must maintain it.
    Get-ChildItem $p -Recurse -File -Force | Where-Object { $_.Name -notlike "*-shm" } | Sort-Object FullName | ForEach-Object {
      $h[$_.FullName.Substring($DataRoot.Length)] = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    }
  }
  return $h
}

function Compare-Hashes($a, $b) {
  $diff = @()
  foreach ($k in ($a.Keys + $b.Keys | Sort-Object -Unique)) {
    if ($a[$k] -ne $b[$k]) { $diff += $k }
  }
  return ,$diff
}

function Get-Marker { (Get-ItemProperty $RegKey -Name InstallInstanceId -ErrorAction SilentlyContinue).InstallInstanceId }
function Set-Marker($v) {
  if ($null -eq $v) { Remove-ItemProperty $RegKey -Name InstallInstanceId -ErrorAction SilentlyContinue }
  else { New-Item $RegKey -Force | Out-Null; Set-ItemProperty $RegKey -Name InstallInstanceId -Value $v }
}

function Restore-Baseline {
  Stop-Motard
  robocopy $Baseline $DataRoot /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "baseline restore failed ($LASTEXITCODE)" }
  Set-Marker $script:BaselineMarker
}

function Wait-StartupState([datetime]$since) {
  $log = Join-Path $DataRoot "logs\startup.log"
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $sinceEpoch = [DateTimeOffset]::new($since).ToUnixTimeSeconds()
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $log) {
      $hit = Get-Content $log -ErrorAction SilentlyContinue | Where-Object {
        $parts = $_ -split " ", 2
        ([int64]$parts[0] -ge $sinceEpoch) -and ($_ -match "STARTUP_STATE=")
      } | Select-Object -Last 1
      if ($hit) { return ($hit -replace '^.*STARTUP_STATE=(\S+).*$', '$1') }
    }
    Start-Sleep -Seconds 1
  }
  return "TIMEOUT"
}

function Invoke-Case([string]$name, [string]$expected, [scriptblock]$mutate, [scriptblock]$cleanup = $null) {
  Write-Host "== $name (expect $expected)"
  Restore-Baseline
  $ctx = & $mutate
  $before = Get-ProtectedHashes
  $since = (Get-Date).AddSeconds(-1)
  Start-Process -FilePath $Exe | Out-Null
  $got = Wait-StartupState $since
  Stop-Motard
  if ($cleanup) { & $cleanup $ctx }
  $after = Get-ProtectedHashes
  $changed = Compare-Hashes $before $after
  $pass = ($got -eq $expected) -and ($changed.Count -eq 0)
  Write-Host ("   state={0} changedFiles={1} -> {2}" -f $got, $changed.Count, $(if ($pass) { "PASS" } else { "FAIL" }))
  return [pscustomobject]@{ case = $name; expected = $expected; observed = $got; changedFiles = $changed; pass = $pass }
}

# ── baseline ────────────────────────────────────────────────────────────────
Stop-Motard
$script:BaselineMarker = Get-Marker
robocopy $DataRoot $Baseline /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "baseline copy failed ($LASTEXITCODE)" }
Write-Host "baseline saved to $Baseline"

$results = @()
try {
  $results += Invoke-Case "foreign data root" "MISMATCH" {
    if ($ForeignDataRoot) {
      robocopy (Join-Path $ForeignDataRoot "data") (Join-Path $DataRoot "data") /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    } else {
      $m = Join-Path $DataRoot "db-meta.json"
      $j = Get-Content $m -Raw | ConvertFrom-Json
      $j.data_id = [guid]::NewGuid().ToString()
      [IO.File]::WriteAllText($m, ($j | ConvertTo-Json -Compress))
    }
  }
  $results += Invoke-Case "device binding deleted" "PRIOR_DATA_FOUND" {
    Remove-Item (Join-Path $DataRoot "device-binding.dat") -Force
  }
  $results += Invoke-Case "install-instance marker removed" "PRIOR_DATA_FOUND" {
    Set-Marker $null
  }
  $results += Invoke-Case "database truncated" "CORRUPT" {
    $fs = [IO.File]::Open((Join-Path $DataRoot "data\motard.db"), "Open", "ReadWrite", "None")
    $fs.SetLength(4096); $fs.Close()
    Get-ChildItem (Join-Path $DataRoot "data") -Filter "motard.db-*" | Remove-Item -Force
  }
  $results += Invoke-Case "data lock held by a foreign process" "LOCKED_UNKNOWN" {
    $lock = Join-Path $DataRoot "motard.lock"
    if (-not (Test-Path $lock)) { New-Item $lock -ItemType File | Out-Null }
    return [IO.File]::Open($lock, "Open", "ReadWrite", "None")
  } { param($fs) if ($fs) { $fs.Close() } }
  $results += Invoke-Case "data folder deleted" "DATA_MISSING" {
    Remove-Item (Join-Path $DataRoot "data") -Recurse -Force
  }
} finally {
  Restore-Baseline
  Remove-Item $Baseline -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "baseline restored"
}

$results | Format-Table case, expected, observed, pass -AutoSize | Out-String | Write-Host
if ($Report) { $results | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $Report }
if ($results | Where-Object { -not $_.pass }) { exit 1 } else { exit 0 }
