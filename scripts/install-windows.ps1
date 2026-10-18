# Installs WatchHouse for Premiere Pro and After Effects on Windows.
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
$ErrorActionPreference = 'Stop'

$src  = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $env:APPDATA 'Adobe\CEP\extensions\WatchHouse'

# Unsigned extensions need PlayerDebugMode (CSXS 9 = 2020, 12 = 2025+).
foreach ($v in 9, 10, 11, 12) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1'
}

if (Test-Path $dest) {
    Write-Host "WatchHouse is already installed at: $dest"
    Write-Host 'Delete that folder first to replace it.'
    exit 1
}

New-Item -ItemType Directory -Path $dest -Force | Out-Null
foreach ($item in 'CSXS', 'client', 'host', 'lib', 'LICENSE') {
    Copy-Item -Path (Join-Path $src $item) -Destination $dest -Recurse
}
Write-Host "Copied to $dest"
Write-Host 'Restart Premiere Pro / After Effects, then open Window > Extensions > WatchHouse.'
