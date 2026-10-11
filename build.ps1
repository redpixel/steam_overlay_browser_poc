#Requires -Version 7
# Builds the modified Spacewar example (Release x64) and stages it in .\bin
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$proj = Join-Path $root 'sdk\steamworksexample'

. (Join-Path $root 'tools\find-vs.ps1')
$msbuild = Join-Path (Find-VisualStudio) 'MSBuild\Current\Bin\amd64\MSBuild.exe'

# Set for this build only (restored afterwards, so a later build in the same shell is unaffected)
$saved = @{ DXSDK_DIR = $env:DXSDK_DIR; CL = $env:CL; LINK = $env:LINK }
try {
  # Legacy D3DX9 (from the Microsoft.DXSDK.D3DX NuGet package) laid out like the old DirectX SDK
  $env:DXSDK_DIR = Join-Path $root 'third_party\dxsdk\'
  # Valve sources contain a '(c)' character that trips C4819 (warning-as-error) on non-Latin code pages
  $env:CL = '/wd4819'
  # XAudio2Create comes from the Windows SDK's xaudio2.lib (the old DirectX SDK version was header-only)
  $env:LINK = 'xaudio2.lib'

  & $msbuild (Join-Path $proj 'SteamworksExample.vcxproj') -nologo -m -v:minimal `
      -p:Configuration=Release -p:Platform=x64 -p:PlatformToolset=v145 "-p:SolutionDir=$proj\"
  if ($LASTEXITCODE -ne 0) { throw "Build failed ($LASTEXITCODE)" }
} finally {
  foreach ($name in $saved.Keys) {
    if ($null -eq $saved[$name]) { Remove-Item "env:$name" -ErrorAction SilentlyContinue } else { Set-Item "env:$name" $saved[$name] }
  }
}

$bin = Join-Path $root 'bin'
New-Item -ItemType Directory -Force $bin | Out-Null
Copy-Item (Join-Path $proj 'win64\Release\steamworksexample.exe') $bin -Force
Copy-Item (Join-Path $root 'sdk\redistributable_bin\win64\steam_api64.dll') $bin -Force
Copy-Item (Join-Path $root 'sdk\public\steam\lib\win64\sdkencryptedappticket64.dll') $bin -Force
Copy-Item (Join-Path $root 'third_party\d3dx\build\native\release\bin\x64\D3DX9_43.dll') $bin -Force
Copy-Item (Join-Path $proj 'DejaVuSans.ttf') $bin -Force
# OverlayBridge overlay bridge, loaded at run time (built by native_bridge\build.ps1; the game runs without it)
$bridge = Join-Path $root 'native_bridge\out\overlay_bridge.dll'
if (Test-Path $bridge) { Copy-Item $bridge $bin -Force } else { Write-Warning "no ${bridge}: the OVB bridge menu will show OFF" }
if (-not (Test-Path (Join-Path $bin 'steam_appid.txt'))) { Set-Content (Join-Path $bin 'steam_appid.txt') '480' -NoNewline }
Write-Host "Output: $bin"
