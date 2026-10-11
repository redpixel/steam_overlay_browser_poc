# Steam 오버레이 웹 팝업 브리지 (PoC)

게임의 웹 팝업을 Steam / Steam Deck 오버레이에서 쓰기 위한 PoC입니다. 웹페이지는 CDN 스크립트 `overlay-bridge.js`로, 게임은 브리지 DLL `overlay_bridge.dll`로 localhost에서 통신합니다.

| 문서 | 내용 |
| --- | --- |
| [docs/overlay-popup-bridge-report.md](docs/overlay-popup-bridge-report.md) | 보고서: 결정 사항, 검증 결과(Windows, Steam Deck), 구조, 보안, 네이티브 브리지 DLL |
| [docs/overlay-bridge-usage.md](docs/overlay-bridge-usage.md) | 웹 개발자용 `overlay-bridge.js` 사용법 |
| [docs/setup.md](docs/setup.md) | 개발 환경 구성(`setup.ps1`), 빌드, 테스트 |

Steamworks SDK(Spacewar 예제)와 D3DX는 저장소에 없습니다. `setup.ps1`이 받아서 구성하고, Spacewar 수정분은 `patches/spacewar.patch`로 적용합니다.
