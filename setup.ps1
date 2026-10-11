#Requires -Version 7
# Recreates what this repository does not contain (third-party code), then optionally builds.
#
#   pwsh .\setup.ps1 -SteamworksSdkZip C:\Downloads\steamworks_sdk_162.zip -AcceptD3DXLicense [-Build] [-Tests]
#
#   sdk\          Steamworks SDK 1.62 (download it from https://partner.steamgames.com/downloads/list,
#                 Steamworks account needed): public\, redistributable_bin\, steamworksexample\,
#                 then patches\spacewar.patch is applied to the Spacewar example.
#                 Skipped when sdk\ is already there with the patch applied (-Force rebuilds it).
#   third_party\  Microsoft.DXSDK.D3DX 9.29.952.8 from nuget.org (license acceptance required:
#                 https://www.nuget.org/packages/Microsoft.DXSDK.D3DX), checked against its SHA-512,
#                 laid out like the old DirectX SDK.
#   -Build        native_bridge\build.ps1 (bridge DLL) and build.ps1 (Spacewar -> bin\).
#   -Tests        npm ci + test app builds + Playwright browsers under tests\. The tests also need the
#                 -Build outputs in native_bridge\out\ (WebView2 tests need the .NET SDK too).
#
# Needs git (to apply the patch), the Visual Studio C++ tools for -Build, Node.js for -Tests.
param(
  [string]$SteamworksSdkZip,
  [switch]$AcceptD3DXLicense,
  [switch]$Build,
  [switch]$Tests,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$sdk = Join-Path $root 'sdk'
$thirdParty = Join-Path $root 'third_party'
$patch = Join-Path $root 'patches\spacewar.patch'
$d3dxVersion = '9.29.952.8'
# nuget.org packageHash of Microsoft.DXSDK.D3DX 9.29.952.8
$d3dxSha512 = '9F6A95ED858555C1C438A85219EDE32C82729068B21DD7ECF11DE01CF3CDD525B2F04A58643BFCC14C48A29403DC1C80246F0A12A1EF4377B91B855F6D6D7986'

function Invoke-Native([string]$what, [scriptblock]$command) {
  & $command
  if ($LASTEXITCODE -ne 0) { throw "$what failed ($LASTEXITCODE)" }
}

if (-not $AcceptD3DXLicense) {
  throw "D3DX (Microsoft.DXSDK.D3DX $d3dxVersion) needs its license accepted: read https://www.nuget.org/packages/Microsoft.DXSDK.D3DX and run again with -AcceptD3DXLicense"
}

# --- Steamworks SDK + Spacewar patch -------------------------------------------
$sdkReady = $false
if ((Test-Path $sdk) -and -not $Force) {
  Push-Location $root
  try {
    git -c core.autocrlf=false apply -R --check --whitespace=nowarn $patch 2>$null
    $sdkReady = $LASTEXITCODE -eq 0
  } finally {
    Pop-Location
  }
  if (-not $sdkReady) { throw "$sdk exists but is not the patched SDK 1.62. Remove it or run with -Force to replace it." }
  Write-Host "Steamworks SDK already set up (patch applied): $sdk"
}
if (-not $sdkReady) {
  if (-not $SteamworksSdkZip) { throw 'Give the Steamworks SDK 1.62 zip: -SteamworksSdkZip <path>' }
  if (-not (Test-Path $SteamworksSdkZip)) { throw "Steamworks SDK zip not found: $SteamworksSdkZip" }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("ovb-setup-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory $tmp | Out-Null
  try {
    Write-Host "Extracting $SteamworksSdkZip"
    Expand-Archive -LiteralPath $SteamworksSdkZip -DestinationPath $tmp
    $src = Join-Path $tmp 'sdk'
    foreach ($dir in 'public', 'redistributable_bin', 'steamworksexample') {
      if (-not (Test-Path (Join-Path $src $dir))) { throw "Not a Steamworks SDK zip (no sdk\$dir)" }
    }
    if (Test-Path $sdk) { Remove-Item -LiteralPath $sdk -Recurse -Force }
    New-Item -ItemType Directory $sdk | Out-Null
    foreach ($dir in 'public', 'redistributable_bin', 'steamworksexample') {
      Copy-Item -LiteralPath (Join-Path $src $dir) -Destination $sdk -Recurse
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  Push-Location $root
  try {
    git -c core.autocrlf=false apply --check --whitespace=nowarn $patch
    if ($LASTEXITCODE -ne 0) { throw "patches\spacewar.patch does not apply: this setup expects Steamworks SDK 1.62" }
    Invoke-Native 'git apply' { git -c core.autocrlf=false apply --whitespace=nowarn $patch }
  } finally {
    Pop-Location
  }
  Write-Host "Steamworks SDK ready, Spacewar patched: $sdk"
}

# --- D3DX (NuGet) laid out like the old DirectX SDK ---------------------------
$d3dx = Join-Path $thirdParty 'd3dx'
$dxsdk = Join-Path $thirdParty 'dxsdk'
if (-not (Test-Path (Join-Path $d3dx 'build\native\include\d3dx9.h'))) {
  New-Item -ItemType Directory -Force $d3dx | Out-Null
  $nupkg = Join-Path ([IO.Path]::GetTempPath()) ("Microsoft.DXSDK.D3DX.$d3dxVersion." + [Guid]::NewGuid().ToString('N') + '.zip')
  try {
    Write-Host "Downloading Microsoft.DXSDK.D3DX $d3dxVersion from nuget.org"
    Invoke-WebRequest "https://www.nuget.org/api/v2/package/Microsoft.DXSDK.D3DX/$d3dxVersion" -OutFile $nupkg
    $hash = (Get-FileHash -LiteralPath $nupkg -Algorithm SHA512).Hash
    if ($hash -ne $d3dxSha512) { throw "Microsoft.DXSDK.D3DX ${d3dxVersion}: unexpected SHA-512 $hash" }
    Expand-Archive -LiteralPath $nupkg -DestinationPath $d3dx -Force
  } finally {
    Remove-Item -LiteralPath $nupkg -Force -ErrorAction SilentlyContinue
  }
}
New-Item -ItemType Directory -Force (Join-Path $dxsdk 'Include'), (Join-Path $dxsdk 'Lib\x64') | Out-Null
Copy-Item (Join-Path $d3dx 'build\native\include\*') (Join-Path $dxsdk 'Include') -Force
Copy-Item (Join-Path $d3dx 'build\native\release\lib\x64\*') (Join-Path $dxsdk 'Lib\x64') -Force
Write-Host "D3DX ready: $thirdParty"

# --- Optional builds -------------------------------------------------------------
if ($Build) {
  & (Join-Path $root 'native_bridge\build.ps1')
  & (Join-Path $root 'build.ps1')
}
if ($Tests) {
  $out = Join-Path $root 'native_bridge\out'
  foreach ($file in 'ovb_vectors.exe', 'ovb_token.dll', 'overlay_bridge.dll', 'nosteam_game.exe', 'nosteam_game_dynamic.exe', 'exit_without_shutdown.exe', 'steam_path_check.exe', 'fake_steam\steam_api64.dll') {
    if (-not (Test-Path (Join-Path $out $file))) { throw "The tests need native_bridge\out\${file}: run with -Build (or native_bridge\build.ps1) first" }
  }
  Push-Location (Join-Path $root 'tests')
  try {
    Invoke-Native 'npm ci (tests)' { npm ci }
    Invoke-Native 'playwright install' { npx playwright install chromium firefox webkit }
    foreach ($app in 'react', 'vue2', 'vue3') {
      Push-Location (Join-Path $root "tests\frameworks\apps\$app")
      try {
        Invoke-Native "npm ci ($app)" { npm ci }
        Invoke-Native "npm run build ($app)" { npm run build }
      } finally {
        Pop-Location
      }
    }
  } finally {
    Pop-Location
  }
}
Write-Host 'Done.'
