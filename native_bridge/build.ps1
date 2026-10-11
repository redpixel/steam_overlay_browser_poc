#Requires -Version 7
# Builds, into native_bridge\out\:
#   overlay_bridge.dll  the native SDK overlay bridge (ovb_bridge.h; ovb_token.c inside, not exported)
#   ovb_token.dll             the token library alone (used by the Python stand-in via ctypes)
#   ovb_vectors.exe           vector printer for the unit tests
#   nosteam_game.exe, nosteam_game_dynamic.exe, exit_without_shutdown.exe,
#   steam_path_check.exe + fake_steam\steam_api64.dll
#                             game-side checks run by tests\unit\native.test.mjs
#
# /MT links the C/C++ runtime statically: the DLLs must not need the VC++ Redistributable
# (vcruntime*.dll, msvcp*.dll, ucrtbase.dll). This is checked after the build.
# Run with PowerShell 7 (pwsh); Windows PowerShell 5.1 treats vcvars' stderr noise as an error.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$out = Join-Path $here 'out'
New-Item -ItemType Directory -Force $out | Out-Null
New-Item -ItemType Directory -Force (Join-Path $out 'fake_steam') | Out-Null

. (Join-Path $here '..\tools\find-vs.ps1')
$vcvars = Join-Path (Find-VisualStudio) 'VC\Auxiliary\Build\vcvars64.bat'

$cmds = @(
  "cl /nologo /W4 /WX /O2 /MT /DOVB_BUILD_DLL /LD `"$here\ovb_token.c`" /Fe:`"$out\ovb_token.dll`" /Fo:`"$out\\`"",
  "cl /nologo /W4 /WX /O2 /MT `"$here\tests\ovb_vectors.c`" `"$here\ovb_token.c`" /Fe:`"$out\ovb_vectors.exe`" /Fo:`"$out\\`"",
  "cl /nologo /W4 /WX /O2 /MT /EHsc /std:c++17 /DOVB_BRIDGE_BUILD /LD `"$here\ovb_bridge.cpp`" `"$here\ovb_token.c`" /Fe:`"$out\overlay_bridge.dll`" /Fo:`"$out\\`"",
  # Test programs for tests\unit\native.test.mjs (a game without Steam, with or without the import library)
  "cl /nologo /W4 /WX /O2 /MT `"$here\tests\nosteam_game.c`" `"$out\overlay_bridge.lib`" /Fe:`"$out\nosteam_game.exe`" /Fo:`"$out\\`"",
  "cl /nologo /W4 /WX /O2 /MT `"$here\tests\nosteam_game_dynamic.c`" /Fe:`"$out\nosteam_game_dynamic.exe`" /Fo:`"$out\\`"",
  "cl /nologo /W4 /WX /O2 /MT `"$here\tests\exit_without_shutdown.c`" /Fe:`"$out\exit_without_shutdown.exe`" /Fo:`"$out\\`"",
  # The Steam path against a fake steam_api64.dll (its own folder, so nothing else picks it up)
  "cl /nologo /W4 /WX /O2 /MT /LD `"$here\tests\fake_steam_api.c`" /Fe:`"$out\fake_steam\steam_api64.dll`" /Fo:`"$out\fake_steam\\`"",
  "cl /nologo /W4 /WX /O2 /MT `"$here\tests\steam_path_check.c`" `"$out\overlay_bridge.lib`" /Fe:`"$out\steam_path_check.exe`" /Fo:`"$out\\`"",
  "dumpbin /nologo /dependents `"$out\ovb_token.dll`" > `"$out\ovb_token.deps.txt`"",
  "dumpbin /nologo /dependents `"$out\overlay_bridge.dll`" > `"$out\overlay_bridge.deps.txt`"",
  "dumpbin /nologo /exports `"$out\overlay_bridge.dll`" > `"$out\overlay_bridge.exports.txt`""
) -join ' && '

cmd /c "`"$vcvars`" >nul && $cmds"
if ($LASTEXITCODE -ne 0) { throw "C build failed ($LASTEXITCODE)" }

# No VC++ Redistributable dependency allowed
foreach ($dll in 'ovb_token', 'overlay_bridge') {
  $deps = Get-Content (Join-Path $out "$dll.deps.txt") | Where-Object { $_ -match '^\s+\S+\.dll\s*$' } | ForEach-Object { $_.Trim() }
  $redist = $deps | Where-Object { $_ -match '^(vcruntime|msvcp|ucrtbase|concrt|vccorlib|api-ms-win-crt-)' }
  if ($redist) { throw "$dll.dll depends on the VC++ Redistributable: $($redist -join ', ')" }
  Write-Host "Built: $dll.dll (depends only on: $($deps -join ', '))"
}
