$ErrorActionPreference = 'Stop'
$root = 'D:\MusicStudioPro'
$cmake = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
$ninja = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe'
$vsdev = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat'

foreach ($tool in @($cmake, $ninja, $vsdev)) {
  if (-not (Test-Path -LiteralPath $tool)) {
    Write-Error "Required build tool was not found: $tool"
  }
}

$batch = Join-Path $env:TEMP 'music-studio-pro-build.cmd'
@"
@echo off
call "$vsdev" -no_logo -arch=x64 -host_arch=x64
if errorlevel 1 exit /b 1
"$cmake" -S "$root" -B "$root\build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_MAKE_PROGRAM="$ninja"
if errorlevel 1 exit /b 1
"$cmake" --build "$root\build"
exit /b %errorlevel%
"@ | Set-Content -LiteralPath $batch -Encoding ASCII

cmd.exe /c $batch
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
