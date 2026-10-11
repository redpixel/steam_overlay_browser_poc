# 전수 검사 결과 (2026-10-11)

C 브리지 DLL, `overlay-bridge.js`, 테스트 서버·테스트, Spacewar 패치·스크립트·문서 네 영역을 읽기 전용으로 검토했습니다. 수정은 아직 하지 않았습니다. 가장 심각한 항목(B1, B2, J1, J2, P1, S3)은 코드에서 직접 다시 확인했습니다.

진행: 1차 수정 완료 (B1–B3, J1–J2, S1–S3, D1–D5), 2차 수정 완료 (B4–B10, J3–J8, J11, J12 일부, P1–P4, D7–D8), 3차 정리 완료 (C1–C8, S4), 4차 테스트 보강 완료 (T1–T9), 5차 완료 (B11–B15, J9, J12). 내용은 보고서의 "전수 검사 1~5차" 절. 검토 항목은 모두 처리했습니다.

구분: **B** 브리지 DLL · **J** overlay-bridge.js · **P** 테스트 서버·테스트 · **S** Spacewar 패치 · **X** 스크립트·저장소 · **D** 문서. 심각도: 높음 / 중간 / 낮음.

## 1. 우선 수정할 버그

| ID | 심각도 | 위치 | 문제 | 수정 |
| --- | --- | --- | --- | --- |
| B1 | 높음 | `ovb_bridge.cpp:466` | 브리지 스레드가 전역 `std::thread`입니다. 게임이 `OVB_Shutdown` 없이 종료하면 DLL 해제 시 `std::terminate`로 게임이 비정상 종료됩니다 | 스레드 핸들을 직접 관리하고, 종료 누락 시 아무것도 하지 않기 |
| B2 | 높음 | `ovb_bridge.cpp:666`, stand-in `:288` | SSE `retry: 1000`(재연결 1초 뒤)인데 유예는 0.5초라서, 순간 끊김을 절대 흡수하지 못하고 항상 `CONNECTION_LOST` | 재연결 간격 < 유예로 조정 (예: retry 300ms, 유예 1.5초) 후 테스트 추가 |
| B3 | 높음 | `ovb_bridge.cpp:477` | Deck 여부를 처음 한 번만 확인. `SteamAPI_Init` 전에 `OVB_Init`하면 Deck에서도 자식 팝업 허용 | `OVB_OpenUrlEx`마다 확인 |
| B4 | 중간 | `SseEvent` | 게임이 보낸 JSON에 CR만 있는 줄바꿈이 있으면 SSE 줄이 깨져 페이지 파싱 실패 | 검증된 JSON의 CR/LF는 공백으로 바꿔 한 줄로 전송 |
| B5 | 중간 | `PushToStreams` | 페이지가 멈춰도 전송 버퍼가 무한히 커짐 (메모리) | 연결당 상한, 넘으면 연결 끊기 |
| B6 | 중간 | `OVB_Shutdown` | 종료 중 콜백 안에서 부른 `OVB_OpenUrl` 등이 성공처럼 동작 | 종료 중 플래그, 모든 함수에서 `ERR_STATE` |
| B7 | 중간 | `MarkClosed` | 아직 열리지 않은 자식 팝업이 `onOpened` 없이 `onClosed`만 받음 | 열리기 전 닫힌 자식은 보고하지 않기 (또는 문서화) |
| B8 | 중간 | `/open` | 자식 팝업 수·전체 팝업 수 제한 없음 (XSS 페이지가 무한 요청 가능) | 부모당·전체 상한 |
| B9 | 중간 | `/open`, `OVB_Shutdown` | 닫히는 중인 팝업에서도 `/open` 허용, 종료 후 대기열 남음 | 닫히는 중 거절, 종료 후 비우기 |
| B10 | 중간 | `openOverlay` 콜백 | 콜백 표시(`g_inCallback`) 없이 호출되어 재진입 가능 | 콜백 표시 적용 |
| B11 | 낮음 | `g_events` | 게임이 `OVB_Update`를 오래 안 부르면 메시지 큐 무한 증가 | 큐 상한, 넘으면 `/message` 거절 |
| B12 | 낮음 | Steam 함수 | 함수 포인터 영구 캐시, 인터페이스 v018/v010만 시도, 오버레이 비활성도 성공 처리 | 매번 확인, 여러 버전 이름 시도, `IsOverlayEnabled` 확인 |
| B13 | 낮음 | `OVB_Init` | 허용 Origin 형식 검증 없음 (끝 `/`, 대문자 등이면 모두 거절됨) | 초기화 때 검증·정규화 |
| B14 | 낮음 | `OVB_Close` | 대기 중(페이지 로딩 중) 팝업을 닫으면 페이지가 화면에 남음 (stand-in도 동일) | 연결 대기를 유지하다가 붙는 즉시 close 전송 |
| B15 | 낮음 | 재연결 | 재연결 시 `hasNotice`만 지우고 사유 문자열은 남음 | 함께 지우기 |
| J1 | 높음 | `overlay-bridge.js:328` | 링크 가로채기가 캡처 단계라 페이지의 `preventDefault`를 못 봄. `onclick`에서 `window.open`도 하는 링크는 팝업 2개 | 버블 단계에서 판단 |
| J2 | 높음 | `overlay-bridge.js:205` | `<base href>`가 다른 도메인이면 `replaceState`가 예외 → `OverlayBridge` 자체가 정의되지 않음 | `location.href` 기준 + try/catch |
| J3 | 중간 | `closeAfterNotice` | 닫기를 두 번 부르면 두 번째가 응답을 안 기다리고 즉시 닫음 → `CONNECTION_LOST` | 닫기 진행 상태 하나로 관리 |
| J4 | 중간 | `closingSent` | 닫기가 거부돼 페이지가 살아 있으면 이후 사용자 닫기 신호가 영원히 안 나감 | 신호 상태 재설정 |
| J5 | 중간 | `close` 이벤트 | 리스너가 끝나면 즉시 닫혀 비동기 마무리 작업 불가 (문서는 "마무리 작업용") | 문서 수정 또는 짧게 대기 |
| J6 | 중간 | EventSource | 브리지가 사라져도 1초마다 무한 재시도, `canOpenPopup()`은 계속 true | N회 실패 후 중단, 세션 살아 있을 때만 true |
| J7 | 중간 | `openPopup` | `canOpenPopup()`이 false인데도 열리는 경우 2가지 (토큰 없는 Steam, http가 아닌 URL) | false면 null |
| J8 | 중간 | `window.open` | 이름 있는 대상(`_self`, iframe 이름, 결제창 이름)까지 새 팝업으로 바꾸고 null 반환 → 기존 결제 코드 오류 가능 | `_blank`·이름 없음만 가로채기 |
| J9 | 낮음 | 링크 | 가운데 클릭, `<base target>`, `download` 링크, form target, SVG 링크 처리 누락 | 각각 처리 |
| J10 | 낮음 | `closePopup` | 사유 64자 제한을 페이지에서 안 지킴 → 거절되어 `CONNECTION_LOST` | 64자로 자르기 |
| J11 | 낮음 | 연결 응답 | `canOpenPopup` 필드가 없으면 true로 간주 | `=== true`, `sid` 형식 확인 |
| J12 | 낮음 | 기타 | keepalive 실패 시 처리 안 된 Promise 거부, 성공 처리 중 예외 미처리, 연결 완료 이벤트 없음 | 각각 처리, `overlaybridge:connected` 이벤트 검토 |
| P1 | 중간 | stand-in `:125` | 닫힌 팝업의 서버 소켓을 닫지 않음 (포트 누수, DLL과 동작 차이) | `server_close()` |
| P2 | 중간 | DLL 호스트 | `/pending`이 메인 스레드가 아닌 곳에서 DLL 호출 | 메인 스레드로 |
| P3 | 중간 | DLL 호스트 | 종료 후 상태를 추정값으로 채움 | `onClosed` 콜백 값으로 기록 |
| P4 | 중간 | 하네스 | 제어 요청 실패를 확인하지 않고, 멱등이 아닌 POST도 재시도 | 실패 시 예외, GET만 재시도 |
| S1 | 높음 | Device ID | 파일을 못 연 경우(보안 프로그램 잠금 등)도 "잘못된 파일"로 보고 유효한 ID를 덮어씀 | 없음 / 형식 오류 / 열기 실패 구분 |
| S2 | 중간 | Device ID | 두 게임이 동시에 잘못된 파일을 고치면 서로 다른 ID | 이동 후 다시 읽어 반환 |
| S3 | 중간 | `OverlayExamples.h:1` | Valve 저작권 줄의 ©가 깨진 문자로 바뀜 (이전 작업의 인코딩 변경) | 원본 바이트로 복원, 패치에서 제거 |
| S4 | 중간 | `OpenBridgePopup` | 실패 상태가 바로 이전 팝업 상태로 덮여 화면에 안 보임 | 실패 시 즉시 반환 |

## 2. 중복 코드·정리

| ID | 위치 | 내용 |
| --- | --- | --- |
| C1 | `ovb_bridge.cpp` / `ovb_token.c` | base64url 구현 2개, 토큰 함수를 헤더 대신 직접 선언 → 공용 함수 하나 |
| C2 | `ovb_bridge.cpp` | "닫기 요청" 로직 3곳, Origin 허용 검사 2곳, `"close"` 이벤트 문자열 4곳 생성, 쓰지 않는 `Popup::launched`, 두 번 파싱하는 `ParseObject` |
| C3 | `overlay-bridge.js` | POST 코드 4벌 → `post()` 하나. `sendClosing`과 `closeAfterNotice`를 상태 하나로 (J3·J4도 해결). `window.open` 대체 코드 3곳 |
| C4 | stand-in / DLL 호스트 | 제어 서버(응답, 라우팅, `/pending`, 로그, 설정)가 거의 같음 → 공용 모듈 `bridge_control.py` + 구현별 백엔드 |
| C5 | 테스트 | 브라우저 준비, 송신 막기 4곳, `_blank` 링크 생성 2곳, 닫기 대기 6곳, 닫고 확인 9곳 → 하네스 헬퍼로 |
| C6 | Spacewar | URL 파일 읽기 2벌(한쪽은 BOM 처리 없음), UTF-8 변환 3벌, 남은 include(`<thread>` 등), ping 문자열 2벌, 이중 `_WIN32` 가드 |
| C7 | 스크립트 | `vswhere` 찾기 방식이 두 스크립트에서 다름, `build.ps1`이 환경 변수를 남김 |
| C8 | 정리 대상 | `/pending.txt`(삭제한 훅 전용), stand-in의 "페이지 이동 재연결" 주석, `target_url` 등 안 쓰는 필드 |

## 3. 테스트 보강

| ID | 내용 |
| --- | --- |
| T1 | 브라우저 없이 Node로 보안 확인 (두 구현 모두): Host·Origin 거부, 키 재사용, 16KB 초과, 잘못된 `Content-Length`, preflight 헤더 |
| T2 | `/open` URL 검증: 비슷한 도메인(`store.example.com.evil.com`, `@`), 대문자, `:443`, `javascript:` |
| T3 | SSE 재연결: 유예 안 / 밖 (B2 확인용) |
| T4 | JSON 그대로 전달 (유니코드, 줄바꿈, 큰 수, 16KB 근처) |
| T5 | DLL API 직접 테스트 (ctypes): 잘못된 인자, 초기화 순서, `OVB_PostMessage` 오류 코드, `OVB_GetPopupInfo` |
| T6 | C 단위 테스트: JSON 리더(깊이 64/65, 서로게이트), HTTP 파싱, SSE 포맷 |
| T7 | 종료 후 재초기화, 손자 팝업, 오버레이 열기 실패 |
| T8 | `nosteam_game*.c`를 빌드 스크립트에 포함 |
| T9 | `sleep` 기반 대기를 조건 대기로 (특히 5.5초 대기 3회) |

## 4. 문서

| ID | 위치 | 내용 |
| --- | --- | --- |
| D1 | 보고서 Deck 절 | "Proton 안 서버 접속 미검증"이 남아 있음 (DLL 절에서 검증 완료) |
| D2 | 보고서 0.6~0.7 절, Deck 표, 체크리스트 | 삭제한 Spacewar 훅을 현재 방식처럼 설명 → "당시 방식"으로 표시 |
| D3 | 보고서 부록, `ovb_bridge.cpp` 주석 | Python stand-in을 "기준 구현"으로 부름 → DLL이 제품, stand-in은 테스트용 |
| D4 | 보고서 부록 | 내부용 문장("이전 시도 정리") 삭제 |
| D5 | 보고서 Device ID | "드라이브 문자 고정 없음", "동시 시작해도 같은 ID"가 코드보다 넓게 주장 (S2, WINEHOMEDIR는 `Z:`만 인식) |
| D6 | 사용 문서 | J2(로드 시 오류 없음), J5(close 이벤트), J7(`canOpenPopup`), B2(0.5초 유예) 관련 설명 |
| D7 | `docs/setup.md` | 테스트에 `-Build` 결과물 필요, Playwright 브라우저 설치, `python` 필요, `test:frameworks:dll`은 Windows cmd 전용, Deck에 `test_page` 복사 단계 |
| D8 | `setup.ps1` | npm 실패를 무시함, `npm ci` 미사용, Playwright 설치 없음, 재실행 불가(`sdk\`가 있으면 중단), D3DX 체크섬 없음, `#Requires -Version 7` 없음 |

## 확인된 정상 항목

- 소켓은 브리지 스레드만 닫아 `select` 중 닫히는 일이 없습니다. 부분 읽기·쓰기를 처리합니다.
- 닫힘 사유 판정은 stand-in과 같습니다. 끊김 뒤 도착한 신호도 포함합니다.
- JSON 중첩은 64단계로 제한되어 있습니다. Host·Origin 검사는 stand-in과 같습니다. 팝업 ID는 재사용하지 않습니다.
- 토큰 해석과 페이지 자체 해시 보존, `replaceState`가 hashchange를 일으키지 않는 점을 확인했습니다.
- 패치는 SDK와 일치합니다. 문서의 테스트 수(단위 11, 프레임워크 158, WebView2 12단계)도 정확합니다.
- 저장소에 올라갈 파일은 모두 이 프로젝트에서 만든 것입니다. lock 파일 4개는 올려도 됩니다.
