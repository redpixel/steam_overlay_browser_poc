# OverlayBridge 사용 안내 (PoC 0.7.4)

네이티브 SDK가 띄우는 팝업 웹페이지와 게임(네이티브) 사이에서 JSON 메시지를 주고받는 스크립트입니다.
API는 WebView2의 `window.chrome.webview`와 같은 모양이며, 웹페이지는 **어떤 환경에서 열렸든 같은 코드**를 사용합니다.

| 환경 | `getEnvironment()` | 동작 |
|---|---|---|
| Steam / Steam Deck 오버레이 | `'steam-overlay'` | 게임의 로컬 브리지(127.0.0.1)와 연결 |
| PC 런처 (WebView2) | `'webview2'` | `window.chrome.webview`에 그대로 전달 |
| 네이티브 SDK 내장 CEF | 예정 (`'cef'`) | 적용 시 같은 API로 연결 예정 |
| 그 외 일반 브라우저 | `'none'` | 연결하지 않음. `postMessage()`는 `false` 반환 |

## 1. 기존 WebView2 코드 옮기기

메시지 내용과 형식은 **바꾸지 않습니다**. 호출하는 객체만 바꿉니다. 런처(네이티브) 쪽 수정은 없습니다.

| 기존 | 변경 |
|---|---|
| `window.chrome.webview.postMessage(msg)` | `OverlayBridge.postMessage(msg)` |
| `window.chrome.webview.addEventListener('message', fn)` | `OverlayBridge.addEventListener('message', fn)` |
| `window.chrome.webview.removeEventListener('message', fn)` | `OverlayBridge.removeEventListener('message', fn)` |

- `fn`은 기존과 같이 `e.data`로 메시지를 받습니다. WebView2 환경에서는 원래 WebView2 이벤트 객체가 그대로 전달됩니다.
- 메시지는 **JSON으로 변환 가능한 값**만 보냅니다.

## 2. 포함하기

`<head>`에 **`async`/`defer` 없이**, 페이지의 다른 스크립트보다 **가장 먼저** 넣습니다.

```html
<head>
  <script src="https://<cdn>/overlay-bridge.js"></script>   <!-- 맨 앞 -->
  <!-- 분석 스크립트(GA 등), 프레임워크 번들은 그 다음 -->
</head>
```

가장 먼저 넣어야 하는 이유는 아래 "연결 정보(키/포트) 처리"를 참고하세요.

- 여러 번 포함되어도 한 번만 초기화됩니다.
- 스크립트가 로드되면 `window`에 `overlaybridge:ready` 이벤트가 발생합니다.
- 외부 라이브러리가 없고 ES5 문법만 사용하므로, 어떤 브라우저에서 열려도 로드 중 오류가 나지 않습니다.
  `Promise`가 없는 구형 브라우저에서도 `postMessage()`는 `then`을 가진 객체를 반환하며, 결과는 `false`입니다.
- 페이지에 CSP가 있다면 `connect-src`에 `http://127.0.0.1:*`을 허용해야 합니다 (Steam 오버레이 경로).

## 3. 연결 정보(`ovbk`) 처리 — 웹 코드 불필요

Steam 오버레이로 열릴 때 게임은 URL `#` 뒤에 연결 정보 하나(`ovbk`)를 붙입니다.
포트와 일회용 키를 합친 47자 base64url 문자열입니다.

```
https://event.example.com/page#ovbk=<47자 토큰>
https://event.example.com/page#/event?tab=2&ovbk=<47자 토큰>     (페이지 자체 해시가 있을 때)
```

**웹페이지는 이 값을 읽거나 저장하거나 지울 필요가 없습니다.** `overlay-bridge.js`가 모두 처리합니다.

1. `ovbk`를 읽어 해석하고, 주소창에서 **그 값만** 지웁니다 (새로고침 없음).
   페이지 자신의 해시는 한 글자도 바뀌지 않습니다. 예: `#/event?tab=2&ovbk=..` → `#/event?tab=2`
2. 키를 게임에서 받은 세션으로 교환합니다(키는 한 번 쓰면 무효). 세션은 메모리에만 두고 저장하지 않습니다.
   그래서 팝업 안에서 다른 페이지로 이동(새로 로드)하면 연결이 끝납니다. 아래 "팝업 안에서의 이동과 새 창"을 참고하세요.
   SPA 라우터의 화면 이동(페이지를 새로 로드하지 않는 이동)은 연결이 그대로 유지됩니다.

웹 쪽이 지킬 것은 **스크립트를 `<head>`에서 가장 먼저 로드**하는 것 하나입니다.

- 해시 라우터(Vue Router `hash` 모드 등)가 먼저 실행되면 `ovbk`가 붙은 해시를 경로로 해석할 수 있습니다.
- 분석 스크립트가 먼저 실행되면 토큰이 붙은 주소가 수집될 수 있습니다 (키는 일회용이라 위험은 낮지만 피하는 것이 좋습니다).
- 페이지 자체 파라미터 이름으로 `ovbk`는 쓰지 마세요. `ovbk_x`처럼 이름이 비슷한 것은 영향받지 않습니다.

`ovbk`는 암호화하지 않습니다. 복호화 키를 이 공개 스크립트 안에 넣어야 하므로 암호화해도 보안상 얻는 것이 없기 때문입니다.
보안은 다음이 담당합니다: 한 번 쓰면 무효가 되는 키, 웹 서버로 전송되지 않는 `#` 위치, 게임 쪽 서버의 Origin/Host 검사, `127.0.0.1` 전용 서버.

### 호환성 확인 결과

아래 조합에서 `ovbk` 처리 후 각 라우터가 원래 경로·쿼리·해시를 그대로 보는 것을 자동 테스트로 확인했습니다 (96개 통과, Steam Deck UA 3개 추가 확인).

| 프레임워크 | 라우터 / 방식 |
|---|---|
| 바닐라 JS | 라우터 없음(쿼리 + `#앵커`), 직접 만든 해시 라우터 |
| React 19 | React Router 7: BrowserRouter, HashRouter |
| Vue 2.7 | Vue Router 3: history, hash |
| Vue 3.5 | Vue Router 4: history, hash |

브라우저 엔진은 Chromium, Firefox, WebKit 세 가지입니다. 각 조합에서 Steam 오버레이 UA와 일반 UA를 모두 확인했습니다.
일반 UA에서는 localhost 연결을 시도하지 않는 것도 함께 확인했습니다.

참고: `?`(쿼리)가 아니라 `#`(fragment)를 쓰는 이유는, `#` 뒤 값은 웹 서버로 전송되지 않기 때문입니다.
서버 접속 로그·Referer에 남지 않고, Next.js/Nuxt의 서버 렌더링에도 전달되지 않습니다.

## 4. API

```js
OverlayBridge.version              // '0.7.4'
OverlayBridge.getEnvironment()     // 'steam-overlay' | 'webview2' | 'none'
OverlayBridge.isAvailable()        // 게임과 연결되어 있으면 true
OverlayBridge.getPopupId()         // 게임이 이 팝업에 부여한 ID (Steam 오버레이). 그 외 환경은 null
OverlayBridge.closePopup('purchase-done')  // 사유를 알리고 팝업 닫기
OverlayBridge.openPopup(url)       // 새 팝업 열기 (Steam: 게임이 추적하는 팝업). Promise<팝업 ID | null>
OverlayBridge.canOpenPopup()       // 새 팝업을 열 수 있는지. Steam Deck에서는 false

// 웹 -> 네이티브 (기존 postMessage와 같은 내용)
OverlayBridge.postMessage({ cmd: 'purchase-result', orderId: 'A123' });
// 필요하면 전달 여부 확인: .then(function (delivered) { ... })

// 네이티브 -> 웹
function onMessage(e) { console.log(e.data); }
OverlayBridge.addEventListener('message', onMessage);
OverlayBridge.removeEventListener('message', onMessage);

// 게임이 팝업을 닫기 직전 (Steam 오버레이). 리스너가 끝나면 바로 창이 닫히므로 동기 작업만 하세요
OverlayBridge.addEventListener('close', function () { ... });

// 게임과 연결됨 (끊겼다가 다시 연결될 때도). 이미 연결된 뒤에 등록하면 곧바로 한 번 호출됩니다(비동기)
OverlayBridge.addEventListener('connected', function () { ... });
```

- 같은 리스너를 두 번 등록해도 한 번만 호출됩니다 (`EventTarget`과 동일).
- `connected`는 "연결됨" 표시처럼 연결 상태에 맞춰 화면을 바꿀 때 씁니다. 메시지를 보내기 위해 기다릴 필요는 없습니다(`postMessage()`는 연결을 기다렸다가 보냅니다). WebView2에서는 등록하자마자 한 번 호출되고, 일반 브라우저에서는 호출되지 않습니다.
- 페이지에서 직접 닫으려면 기존처럼 `window.close()`를 호출하면 됩니다. Steam 오버레이에서는 이 경우도 게임에 "페이지가 닫음"(`PAGE_REQUEST`, 사유 `window.close`)으로 전달됩니다.
- 닫는 이유를 게임에 알리고 싶으면 `OverlayBridge.closePopup(reason)`을 씁니다 (`reason`은 64자 이내 문자열, 넘으면 잘라서 보냄, 없으면 `page`). WebView2·일반 브라우저에서는 `window.close()`와 같습니다.
- 닫기를 여러 번 불러도(더블 클릭, `closePopup` 뒤 `window.close`) 첫 번째만 처리됩니다.
- Steam 오버레이에서 `window.close()`·`closePopup()`을 부르면, 게임에 닫는 이유를 먼저 전달한 뒤 창이 닫힙니다. 그래서 닫힘이 최대 0.3초 늦어질 수 있습니다(실측 0.1~0.3초). 창을 닫기 직전에 보낸 신호는 오버레이가 페이지를 즉시 정리하면서 사라질 수 있어서입니다.

### 팝업 안에서의 이동과 새 창 (Steam 오버레이)

Steam 오버레이 팝업은 **제자리에서 다른 페이지로 이동하지 않는 것**을 전제로 합니다. 새 내용은 새 팝업으로 엽니다.
그래야 게임이 모든 창을 추적하고 닫을 수 있습니다.

- 새 창을 여는 동작은 스크립트가 자동으로 가로채 게임에 새 팝업을 요청합니다. 기존 코드를 바꿀 필요가 없습니다.
  - `window.open(url)` (이름 없음 또는 `_blank`)
  - `target="_blank"` 링크, `<base target="_blank">` 아래의 target 없는 링크, SVG 링크(`xlink:href` 포함)
  - Ctrl·Shift·Cmd + 클릭, 마우스 가운데 클릭
  - `target="_blank"`(또는 `formtarget`)인 GET 폼: 폼 값을 붙인 주소를 새 팝업으로 엽니다
- 가로채지 않는 것(브라우저 기본 동작, 게임이 추적하지 않는 창):
  이름을 준 `window.open(url, 'payWindow')`, `_self` 등, `download` 링크, **`target="_blank"`인 POST 폼**(게임은 주소만 열 수 있어서 POST 본문을 옮길 수 없음).
  POST 결과를 새 팝업으로 보여야 하면 GET으로 바꾸거나, 서버에서 받은 주소를 `openPopup()`으로 여세요.
  페이지가 직접 처리한 링크·폼(`preventDefault`)도 건드리지 않습니다.
  이때 `window.open()`은 `null`을 반환합니다(새 창 객체를 돌려줄 수 없음). 반환값을 쓰는 코드는 `openPopup(url)`로 바꾸세요.
- 이렇게 연 팝업은 원래 팝업의 **자식**입니다. 원래 팝업이 닫히면 자식도 게임이 함께 닫습니다.
- 게임이 허용하지 않는 도메인이면 아무것도 열리지 않고 `openPopup()`은 `null`입니다.
- 일반 링크(같은 창 이동)나 `location.href` 변경으로 페이지를 새로 로드하면, 그 팝업은 닫힌 것으로 처리되고 새 페이지는 연결되지 않습니다.
  팝업 안의 이동은 SPA 라우팅으로 하거나 새 팝업으로 여세요.

**Steam Deck:** Deck 오버레이는 웹 페이지를 한 번에 하나만 보여줍니다. 두 번째 페이지는 앞 페이지 뒤에 대기하거나 로딩 상태로 멈춰서,
자식 팝업을 쓸 수 없습니다. 그래서 Deck에서는 `canOpenPopup()`이 `false`이고, `openPopup()`·`window.open()`·새 창 링크·폼은
**아무것도 열지 않습니다**(`null`). 약관·도움말처럼 링크로 열던 내용은 페이지 안의 레이어로 보여 주세요.

```js
if (OverlayBridge.canOpenPopup()) {
  OverlayBridge.openPopup('https://store.example.com/terms');
} else {
  showTermsLayer();   // 페이지 안에서 표시
}
```

- `canOpenPopup()`은 Steam 오버레이에서 게임과 연결된 뒤에 값이 정해집니다. 연결 전이거나 연결에 실패하면 `false`입니다.
  `openPopup()`은 연결을 기다린 뒤 판단하므로, 페이지 로드 직후에 불러도 됩니다. http(s)가 아닌 URL은 열지 않습니다.
- 연결 정보(`ovbk`) 없이 Steam 오버레이에서 열린 페이지는 게임이 관리하지 않으므로 `canOpenPopup()`이 `true`이고, `openPopup()`은 일반 `window.open`입니다.
- WebView2·일반 브라우저에서는 항상 `true`이며, `openPopup()`은 일반 `window.open(url, '_blank')`와 같습니다(`null` 반환).
- 열 수 있는지는 게임(네이티브 SDK)이 연결할 때 알려줍니다. UA로 판단하지 않습니다.

### 연결에 실패했을 때

Steam 오버레이에서 연결 정보는 있는데 처음부터 게임과 연결하지 못하면(게임 쪽 서버가 없음, 키를 이미 사용함, 게임이 이미 팝업을 정리함,
허용되지 않은 도메인, 브라우저의 로컬 접속 차단 등) **페이지가 스스로 닫힙니다**(약 0.6초 안에 3번 시도한 뒤).
게임은 서버를 먼저 연 다음 페이지를 띄우므로, 이런 페이지는 게임이 기다리는 팝업이 아닙니다.
예: 오버레이가 꺼진 상태에서 요청된 페이지를 Steam이 다음 실행 때 띄우는 경우(이전 실행의 연결 정보라 연결되지 않음).

닫히지 않게 하려면 스크립트 태그에 `data-auto-close="false"`를 붙입니다. 개발 중 허용 도메인 설정을 확인할 때처럼, 연결 실패 화면을 봐야 할 때 씁니다.

```html
<script src="https://<cdn>/overlay-bridge.js" data-auto-close="false"></script>
```

이때는 `isAvailable()`과 `canOpenPopup()`이 `false`이고, `postMessage()`는 `false`로 끝나며, 새 창은 열리지 않습니다.
연결된 뒤 게임 쪽 브리지가 사라진 경우(게임 종료 등)는 자동으로 닫지 않습니다. 재연결을 10번 실패하면 위와 같은 상태가 되고 재시도를 멈춥니다.
이 상태에서는 게임과 통신할 수 없으므로 안내 문구와 페이지 자체 닫기 버튼(`window.close()`)을 보여 주세요.

### 스크립트보다 먼저 실행될 수 있는 코드에서

```js
function withOverlayBridge(callback) {
  if (window.OverlayBridge) {
    callback(window.OverlayBridge);
  } else {
    window.addEventListener('overlaybridge:ready', function () { callback(window.OverlayBridge); }, { once: true });
  }
}
```

## 5. TypeScript

`overlay-bridge.d.ts`를 프로젝트에 복사합니다 (예: `src/types/overlay-bridge.d.ts`).
`window.OverlayBridge`는 로드 전이나 SSR 중에는 `undefined`이므로 `?.`로 접근합니다.

```ts
window.OverlayBridge?.postMessage({ cmd: 'opened', page: 'event' });
```

## 6. 프레임워크별 예시

### 일반 HTML / jQuery

```html
<script src="https://<cdn>/overlay-bridge.js"></script>
<script>
  OverlayBridge.addEventListener('message', function (e) { console.log(e.data); });
  document.getElementById('done').onclick = function () {
    OverlayBridge.postMessage({ cmd: 'event-done', id: 7 });
  };
</script>
```

### React

```jsx
import { useEffect, useState } from 'react';

export function useOverlayBridgeMessage(onMessage) {
  useEffect(() => {
    const bridge = window.OverlayBridge;
    if (!bridge) return undefined;
    bridge.addEventListener('message', onMessage);
    return () => bridge.removeEventListener('message', onMessage);   // 언마운트 시 해제
  }, [onMessage]);
}

function EventPage() {
  const [env, setEnv] = useState('none');
  useEffect(() => { setEnv(window.OverlayBridge?.getEnvironment() ?? 'none'); }, []);
  return <button onClick={() => window.OverlayBridge?.postMessage({ cmd: 'event-done', id: 7 })}>완료 ({env})</button>;
}
```

### Vue 2 (Options API)

```js
export default {
  mounted() {
    this.onBridgeMessage = (e) => { this.lastMessage = e.data; };
    window.OverlayBridge && window.OverlayBridge.addEventListener('message', this.onBridgeMessage);
  },
  beforeDestroy() {
    window.OverlayBridge && window.OverlayBridge.removeEventListener('message', this.onBridgeMessage);
  },
  methods: {
    done() { window.OverlayBridge && window.OverlayBridge.postMessage({ cmd: 'event-done', id: 7 }); }
  }
};
```

### Vue 2.7 / Vue 3 (Composition API)

```js
import { onMounted, onBeforeUnmount } from 'vue';

export function useOverlayBridgeMessage(onMessage) {
  onMounted(() => window.OverlayBridge && window.OverlayBridge.addEventListener('message', onMessage));
  onBeforeUnmount(() => window.OverlayBridge && window.OverlayBridge.removeEventListener('message', onMessage));
}
```

Vue 공통: `OverlayBridge` 객체를 `data()`/`reactive()`/`ref()`에 넣지 말고 `window.OverlayBridge`로 직접 호출하세요.

### Next.js (App Router)

스크립트는 루트 레이아웃에서 `beforeInteractive`로 넣습니다. 앱 코드보다 먼저 실행되어야 합니다.

```jsx
// app/layout.jsx
import Script from 'next/script';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Script src="https://<cdn>/overlay-bridge.js" strategy="beforeInteractive" />
      </body>
    </html>
  );
}
```

`OverlayBridge`를 쓰는 컴포넌트는 `'use client'`로 두고, **`useEffect` 안에서만** 접근합니다 (위 React 예시와 동일).
Pages Router는 `pages/_document.jsx`에 같은 `<Script strategy="beforeInteractive">`를 넣습니다.

### Nuxt 3

```js
// nuxt.config.ts
export default defineNuxtConfig({
  app: {
    head: {
      script: [{ src: 'https://<cdn>/overlay-bridge.js', tagPosition: 'head' }]
    }
  }
});
```

`OverlayBridge` 접근은 `onMounted` 이후나 `.client` 플러그인에서만 합니다.

### Nuxt 2 (Vue 2)

```js
// nuxt.config.js
export default {
  head: {
    script: [{ src: 'https://<cdn>/overlay-bridge.js' }]
  }
};
```

`OverlayBridge` 접근은 `mounted()` 이후나 클라이언트 전용 플러그인(`plugins: [{ src: '~/plugins/x.js', mode: 'client' }]`)에서만 합니다.

### SSR 공통 주의

- 서버 렌더링 중에는 `window.OverlayBridge`가 없습니다. 컴포넌트 본문이나 모듈 최상단에서 접근하면 안 됩니다.
- 첫 화면을 `isAvailable()`/`getEnvironment()` 값에 따라 다르게 그리면 hydration 불일치가 납니다. 마운트 후 state로 반영하세요.

## 7. 제약 사항 (Steam 오버레이 경로)

- 팝업 안에서 페이지를 새로 로드하면(같은 도메인이어도) 그 팝업의 연결은 끝나고 게임에는 닫힘(`USER_CLOSED`)으로 보입니다. 위 "팝업 안에서의 이동과 새 창"을 참고하세요.
- 사용자가 닫은 경우의 사유(`USER_CLOSED`)는 **최선 노력**입니다. 페이지가 내려가며 보내는 신호가 오버레이에 의해 버려지면 `CONNECTION_LOST`로 보입니다(Windows X 버튼에서 3회 중 1회 확인). 게임은 두 사유를 같은 방식(팝업이 페이지 완료 없이 사라짐)으로 처리해야 합니다.
- Steam Deck에서는 팝업을 한 번에 하나만 쓸 수 있습니다(위 참고).
- 브라우저 정책 변경(Chrome Local Network Access)으로 향후 연결이 막힐 수 있으므로, 페이지 자체의 닫기 버튼(`window.close()`)은 항상 유지하세요.
- `ovbk` 토큰은 버전(1바이트)과 길이만 검사합니다. 값이 바뀌면 다른 포트로 접속을 시도하거나 키가 맞지 않아 거부됩니다. URL은 게임이 만들어 Steam에 직접 넘기므로 중간 변조 경로는 없습니다.

## 8. 네이티브 SDK 구현 참고

웹 개발자는 신경 쓰지 않아도 되는 부분입니다. 게임 쪽은 네이티브 브리지 DLL(`native_bridge/ovb_bridge.h`, `overlay_bridge.dll`)이 구현합니다. API·스레드·배포 구성은 보고서의 "네이티브 브리지 DLL" 절을 참고하세요. Python 대역(`tests/frameworks/bridge_native_standin.py`)은 같은 규칙의 테스트용 구현입니다.

**팝업 URL** (C 라이브러리 `native_bridge/ovb_token.c`의 `ovb_build_popup_url()`)

- URL에 `#`이 없으면 `#ovbk=<token>`을 붙입니다. 이미 `#`이 있으면 기존 해시 뒤에 `&ovbk=<token>`을 붙입니다. URL의 나머지는 바꾸지 않습니다.
- 토큰 형식: `base64url( 버전 0x01 | 포트 2바이트(big-endian) | 키 32바이트 )`, 패딩 없이 47자. 암호화하지 않습니다.
- 키는 팝업마다 `ovb_random()`(OS 암호 난수)으로 새로 만들고, 브리지 서버가 첫 연결에서 한 번만 받아들입니다.

**엔드포인트** (팝업마다 `127.0.0.1:<임의 포트>`. 모든 요청에서 Host와 Origin 허용 목록 검사)

| 요청 | 내용 |
|---|---|
| `POST /connect {key}` | 응답 `{sid, popupId, canOpenPopup}`. `popupId`는 `OVB_OpenUrl`이 돌려준 값. `canOpenPopup`은 Steam Deck(`IsSteamRunningOnSteamDeck()`)이면 `false` |
| `GET /events?sid=` | SSE. `message`(JSON 그대로), `close` |
| `POST /message {sid, message}` | 웹 → 네이티브. 메시지는 변환하지 않음 |
| `POST /closing {sid, popupId, reason, explicit}` | 형식 `text/plain`. 세션과 `popupId`가 일치할 때만 수락하고 바로 응답 |
| `POST /open {sid, url}` | 자식 팝업 요청. `canOpenPopup`이 `false`이거나 허용되지 않은 도메인이면 거절. 수락하면 새 팝업(부모 = 이 팝업)을 만들고 `{popupId}` 응답 |

**페이지가 보내는 닫기 신호**

- 명시적 닫기(`window.close()`, `closePopup`): 일반 요청으로 보내고 응답(또는 0.3초)을 기다린 뒤 창을 닫습니다. `explicit: true`.
- 그 밖에 페이지가 내려갈 때: `visibilitychange`(hidden), `beforeunload`, `pagehide`마다 한 번씩 `sendBeacon`으로 보냅니다. `explicit: false`.
  Steam Deck의 B / Steam 버튼은 페이지를 빠르게 정리해서 `beforeunload`·`pagehide` 신호가 자주 사라지고 `hidden`만 확실히 도착합니다.
  리스너는 스크립트가 로드될 때 캡처 단계로 등록해, 페이지의 다른 요청보다 먼저 나가게 합니다.

**닫힘 사유** (`OVB_OnClosed`의 `reason`. 팝업당 한 번, 확정 후 변경 없음)

| 사유 | 판정 |
|---|---|
| `NATIVE_REQUEST` | 게임이 `OVB_Close`로 닫음. 부모가 닫혀 함께 닫힌 자식도 포함 |
| `PAGE_REQUEST` | 명시적 닫기 신호 후 5초 안에 연결이 끊김 |
| `USER_CLOSED` | 명시적이 아닌 신호 후 5초 안에 연결이 끊김 (X 버튼, Deck B / Steam 버튼, 제자리 이동). 최선 노력 |
| `CONNECTION_LOST` | 신호 없이 끊기고 1초 안에 다시 붙지 않음 (크래시, 신호가 버려진 사용자 닫기 등) |
| `NEVER_CONNECTED` | 제한 시간(기본 300초, 자식은 게임이 연 시점부터) 안에 페이지가 연결하지 않음 |
| `SHUTDOWN` | 게임이 `OVB_Shutdown`으로 정리함 |

- 끊긴 뒤 1초 유예는 순간적인 끊김만 흡수합니다. 서버는 SSE에 `retry: 200`을 보내 브라우저가 유예 안에 다시 붙게 합니다. 그 안에 신호가 늦게 도착해도 판정에 반영됩니다(Deck에서 끊김 3ms 뒤 도착한 `hidden` 신호 확인).
- `hidden` 신호 후 페이지가 다시 보이고 살아 있으면(Windows Shift+Tab) 닫힘이 아닙니다. 5초가 지나면 그 신호는 판정에 쓰이지 않습니다.
- C 라이브러리는 Windows SDK만 사용합니다 (`bcrypt`로 난수 생성). macOS/Linux는 추후 지원 예정입니다.
