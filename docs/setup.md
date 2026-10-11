# 개발 환경 구성과 빌드

저장소에는 이 프로젝트에서 만든 코드만 들어 있습니다. Valve의 Steamworks SDK(Spacewar 예제 포함)와 Microsoft D3DX는 저작권 때문에 올리지 않고, `setup.ps1`이 받아서 구성합니다. Spacewar 수정분은 원본에 적용하는 패치(`patches/spacewar.patch`)로만 들어 있습니다.

## 준비물

| 항목 | 용도 |
| --- | --- |
| Steamworks SDK 1.62 zip | [Steamworks 다운로드](https://partner.steamgames.com/downloads/list)에서 받음 (Steamworks 계정 필요). 다른 버전은 패치가 맞지 않음 |
| Git | 패치 적용 |
| Visual Studio 2026 C++ 도구 (v145) | 브리지 DLL, Spacewar 빌드 |
| PowerShell 7 (`pwsh`) | 스크립트 실행 |
| Node.js, Python 3 (`python` 명령) | 자동 테스트 (선택) |
| .NET SDK | WebView2 테스트 (선택) |

## 구성

```powershell
pwsh .\setup.ps1 -SteamworksSdkZip C:\Downloads\steamworks_sdk_162.zip -AcceptD3DXLicense -Build -Tests
```

| 단계 | 결과 |
| --- | --- |
| SDK 압축 해제 | `sdk\public`, `sdk\redistributable_bin`, `sdk\steamworksexample` |
| 패치 적용 | `patches\spacewar.patch` → Spacewar 5개 파일 (`OverlayExamples.cpp/.h`, `SpaceWarClient.cpp/.h`, `gameenginewin32.cpp`) |
| D3DX | nuget.org의 `Microsoft.DXSDK.D3DX` 9.29.952.8 → SHA-512 확인 → `third_party\d3dx`, 옛 DirectX SDK 구조로 `third_party\dxsdk` (라이선스 동의 필요: `-AcceptD3DXLicense`) |
| `-Build` | `native_bridge\out\overlay_bridge.dll`, `bin\steamworksexample.exe` (+ 실행에 필요한 DLL) |
| `-Tests` | `tests\`와 React·Vue 테스트 앱의 `npm ci`, 테스트 앱 빌드, Playwright 브라우저(Chromium·Firefox·WebKit) 설치. `-Build` 결과물(`native_bridge\out\`)이 있어야 함 |

`sdk\`가 이미 있고 패치가 적용된 상태면 그 단계를 건너뛰므로, `-Build`·`-Tests`만 다시 실행할 수 있습니다. 다른 상태면 멈추고, `-Force`로 다시 구성합니다. 2026-10-11에 저장소 파일만 있는 새 폴더에서 구성부터 빌드까지 확인했습니다.

## 따로 빌드할 때

| 명령 | 결과 |
| --- | --- |
| `pwsh .\native_bridge\build.ps1` | 브리지 DLL, 토큰 DLL, 테스트용 실행 파일. VC++ 재배포 패키지 의존성이 생기면 실패 |
| `pwsh .\build.ps1` | Spacewar → `bin\` (브리지 DLL도 복사) |

## 테스트

`tests\`에서 실행합니다. `native_bridge\build.ps1`의 결과물(`ovb_vectors.exe`, `ovb_token.dll`, `overlay_bridge.dll`, 테스트 프로그램 `nosteam_game.exe`, `nosteam_game_dynamic.exe`, `exit_without_shutdown.exe`, `steam_path_check.exe`와 가짜 `fake_steam\steam_api64.dll`)이 필요합니다.

| 명령 | 내용 |
| --- | --- |
| `npm run test:unit` | 토큰, ES5, 구형 브라우저 환경, 브리지 DLL C API(`tests/dll/api_check.py`), Steam 없는 게임, 가짜 `steam_api64.dll`로 Steam 경로(오버레이 꺼짐·Deck), `OVB_Shutdown` 없는 종료 (Windows) |
| `npm run test:frameworks` | 프레임워크 호환성·닫힘 사유·브라우저 없는 프로토콜 검사 (게임 쪽 = Python 대역) |
| `npm run test:frameworks:dll` | 같은 테스트 (게임 쪽 = 브리지 DLL). npm 스크립트가 `set`을 써서 Windows에서만 동작 |
| `npm run test:webview2` | WebView2 테스트 호스트 |

## 저장소에 넣지 않는 것

`.gitignore` 기준: `sdk/`, `third_party/`, `bin/`, `native_bridge/out/`, 테스트 앱의 `dist/`, `node_modules/`, WebView2 호스트의 `bin/`·`obj/`, 로그.

## 실제 오버레이에서 수동 테스트

1. 테스트 페이지 서버: `python -m http.server 8766 --bind 127.0.0.1 --directory test_page`
2. `bin\steamworksexample.exe` 실행 (Steam 실행 중이어야 함), 오버레이 메뉴의 `[OVB Bridge] Open popup`
3. 기록: `bin\overlay_browser_test.log`

Steam Deck은 devkit client로 `bin\`을 올리고(Steam Play 체크), `test_page\` 폴더를 Deck에 복사한 뒤(예: devkit 키로 `scp`) 페이지 서버를 Deck 안에서 `python3`로 같은 명령으로 띄웁니다.
