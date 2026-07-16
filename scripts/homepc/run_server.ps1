<#
Meeting Master — start the home AI server (FastAPI on 0.0.0.0:8080).

Creates server/.venv on first run, installs requirements when they change,
then runs uvicorn in the foreground. Configuration is read by the app itself
from server/server.env (see docs/SETUP_HOMEPC.md) — nothing is exported here.

Task Scheduler (auto-start at logon):
  schtasks /Create /TN "MeetingMaster Server" /SC ONLOGON /TR `
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\Meeting-Master\scripts\homepc\run_server.ps1"
Or create the task in the GUI with trigger "At log on" and that same command.
NSSM (https://nssm.cc) can wrap this script as a Windows service instead if
you want auto-restart on crash.
#>

$ErrorActionPreference = 'Stop'

# server/ relative to this script (scripts/homepc/ -> ../../server).
$serverDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../server'))
Set-Location $serverDir

# Create the virtual environment on first run.
if (-not (Test-Path (Join-Path $serverDir '.venv'))) {
    Write-Host 'Creating Python virtual environment in server/.venv ...'
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'python -m venv failed — is Python on PATH?' }
}

# Windows venvs put python under Scripts/, Linux (pwsh dev) under bin/.
$venvPython = Join-Path $serverDir '.venv/Scripts/python.exe'
if (-not (Test-Path $venvPython)) {
    $venvPython = Join-Path $serverDir '.venv/bin/python'
}

# Install dependencies only when requirements.txt is newer than the stamp
# left by the last successful install — keeps day-to-day startup instant.
$requirements = Join-Path $serverDir 'requirements.txt'
$stamp = Join-Path $serverDir '.venv/.requirements.stamp'
if (-not (Test-Path $stamp) -or
    ((Get-Item $requirements).LastWriteTimeUtc -gt (Get-Item $stamp).LastWriteTimeUtc)) {
    Write-Host 'Installing/updating Python dependencies ...'
    & $venvPython -m pip install -r $requirements
    if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }
    New-Item -ItemType File -Path $stamp -Force | Out-Null
}

# Foreground server; Ctrl+C stops it. 0.0.0.0 so `tailscale serve` (and LAN
# testing) can reach it — auth is enforced per-request via the bearer token.
& $venvPython -m uvicorn app.main:app --host 0.0.0.0 --port 8080
