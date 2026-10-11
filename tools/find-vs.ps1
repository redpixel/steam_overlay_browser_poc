# Shared by build.ps1 and native_bridge\build.ps1: the newest Visual Studio (or Build Tools) with
# the x64 C++ tools. Throws with what is missing.
function Find-VisualStudio {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) { throw "vswhere.exe not found ($vswhere): install Visual Studio 2026 or its Build Tools" }
  $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $vs) { throw 'No Visual Studio with the C++ x64 tools (workload "Desktop development with C++")' }
  return $vs
}
