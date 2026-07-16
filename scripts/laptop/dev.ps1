<#
Meeting Master — run the Electron app from source (development).

Installs node_modules on first run, then starts Electron. In dev the app also
reads a laptop.env placed next to app/package.json (see docs/SETUP_LAPTOP.md).
Dev nicety once running: Ctrl+Shift+M loads the mock meeting fixture.
#>

$ErrorActionPreference = 'Stop'

# app/ relative to this script (scripts/laptop/ -> ../../app).
$appDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../app'))
Set-Location $appDir

if (-not (Test-Path (Join-Path $appDir 'node_modules'))) {
    Write-Host 'node_modules missing — running npm install ...'
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
}

npm start
