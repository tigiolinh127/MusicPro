# Runs every automated build and test used for phase sign-off and writes one log per step.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\run-regression.ps1 -OutDir build\phase22-baseline [-SkipNative]
param(
    [Parameter(Mandatory = $true)][string]$OutDir,
    [switch]$SkipNative,
    [switch]$SkipGui
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $root 'apps\desktop'
$out = if ([System.IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $root $OutDir }
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force $out | Out-Null
$summary = New-Object System.Collections.Generic.List[string]

function Step([string]$name, [scriptblock]$body) {
    $log = Join-Path $out "$name.log"
    $started = Get-Date
    & $body *>&1 | Out-File -FilePath $log -Encoding utf8 -Width 400
    $code = $LASTEXITCODE
    $seconds = [int]((Get-Date) - $started).TotalSeconds
    $line = '{0,-22} exit={1} ({2}s)' -f $name, $code, $seconds
    $summary.Add($line)
    Write-Output $line
}

if (-not $SkipNative) {
    Step 'native-build' { powershell -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\build-engine.ps1') }
}
Step 'native-tests' { & (Join-Path $root 'build\audio_engine_tests.exe') }
Step 'phase0-script' { python (Join-Path $root 'scripts\verify-phase0-fixtures.py') }
Push-Location $desktop
Step 'tsc-renderer' { npx tsc -p tsconfig.json --noEmit }
Step 'tsc-electron' { npx tsc -p tsconfig.electron.json --noEmit }
Step 'desktop-build' { npm run build }
if (-not $SkipGui) {
    $env:MUSICSTUDIO_ENGINE = Join-Path $root 'build\MusicStudioEngine.exe'
    Step 'smoke' { $env:MSP_SMOKE = '1'; npx electron .; $env:MSP_SMOKE = $null }
    Step 'layout-check' { $env:MSP_LAYOUT_CHECK = (Join-Path $out 'layout'); npx electron .; $env:MSP_LAYOUT_CHECK = $null }
    Step 'workflow-edit' { $env:MSP_WORKFLOW_CHECK = (Join-Path $out 'workflow'); $env:MSP_WORKFLOW_PHASE = 'edit'; npx electron . }
    Step 'workflow-reload' { $env:MSP_WORKFLOW_CHECK = (Join-Path $out 'workflow'); $env:MSP_WORKFLOW_PHASE = 'reload'; npx electron .; $env:MSP_WORKFLOW_CHECK = $null; $env:MSP_WORKFLOW_PHASE = $null }
    Step 'mixer-build' { $env:MSP_MIXER_CHECK = (Join-Path $out 'mixer'); $env:MSP_MIXER_PHASE = 'build'; npx electron . }
    Step 'mixer-reload' { $env:MSP_MIXER_CHECK = (Join-Path $out 'mixer'); $env:MSP_MIXER_PHASE = 'reload'; npx electron .; $env:MSP_MIXER_CHECK = $null; $env:MSP_MIXER_PHASE = $null }
    if ($env:MSP_RUN_FX -eq '1') {
        Step 'fx-build' { $env:MSP_FX_CHECK = (Join-Path $out 'fx'); $env:MSP_FX_PHASE = 'build'; npx electron . }
        Step 'fx-reload' { $env:MSP_FX_CHECK = (Join-Path $out 'fx'); $env:MSP_FX_PHASE = 'reload'; npx electron .; $env:MSP_FX_CHECK = $null; $env:MSP_FX_PHASE = $null }
    }
    Step 'auto-build' { $env:MSP_AUTO_CHECK = (Join-Path $out 'auto'); $env:MSP_AUTO_PHASE = 'build'; npx electron . }
    Step 'auto-reload' { $env:MSP_AUTO_CHECK = (Join-Path $out 'auto'); $env:MSP_AUTO_PHASE = 'reload'; npx electron .; $env:MSP_AUTO_CHECK = $null; $env:MSP_AUTO_PHASE = $null }
}
Pop-Location
$summary | Out-File -FilePath (Join-Path $out 'summary.txt') -Encoding utf8
