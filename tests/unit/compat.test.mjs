// overlay-bridge.js must load without errors in any browser, not only Chromium.
// 1. The source is ES5 syntax only.
// 2. In a legacy environment (no Promise, CustomEvent constructor, fetch, EventSource,
//    typed arrays, URLSearchParams) it loads, reports 'none' and the API still works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = readFileSync(path.join(root, 'test_page', 'overlay-bridge.js'), 'utf8');

test('source parses as ES5 (no arrow functions, let/const, classes, template literals...)', () => {
  assert.doesNotThrow(() => acorn.parse(source, { ecmaVersion: 5, sourceType: 'script' }));
});

function legacyWindow(userAgent) {
  const fired = [];
  const ctx = {
    navigator: { userAgent },
    document: {
      createEvent() {
        return { initCustomEvent(type, bubbles, cancelable, detail) { this.type = type; this.detail = detail; } };
      },
    },
    dispatchEvent(e) { fired.push(e); },
    setTimeout,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  // Remove what old browsers do not have
  vm.runInContext('delete Promise; delete Uint8Array; delete Uint32Array; delete Map; delete Set; delete Symbol;', ctx);
  return { ctx, fired };
}

for (const ua of ['Mozilla/4.0 (compatible; MSIE 11.0; Windows NT 10.0; Trident/7.0)',
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Valve Steam GameOverlay/default/1)',
                  'Mozilla/5.0 (X11; Linux x86_64; Valve Steam Gamepad [Steam Deck stable]/default/1)']) {
  test(`legacy environment loads cleanly and reports 'none' (UA: ${ua.slice(0, 40)}...)`, () => {
    const { ctx, fired } = legacyWindow(ua);
    assert.doesNotThrow(() => vm.runInContext(source, ctx));

    const B = ctx.OverlayBridge;
    assert.equal(B.getEnvironment(), 'none');
    assert.equal(B.isAvailable(), false);
    assert.equal(fired.length, 1, 'overlaybridge:ready fired via document.createEvent');
    assert.equal(fired[0].type, 'overlaybridge:ready');
    assert.equal(fired[0].detail.environment, 'none');

    let result = 'not called';
    const thenable = B.postMessage({ cmd: 'x' });
    assert.equal(typeof thenable.then, 'function', 'postMessage returns a thenable without Promise');
    thenable.then((v) => { result = v; });
    assert.equal(result, false);

    const fn = () => {};
    assert.doesNotThrow(() => { B.addEventListener('message', fn); B.removeEventListener('message', fn); });
    assert.equal(B.getPopupId(), null);
    assert.equal(B.canOpenPopup(), true, 'a plain window.open outside the Steam overlay');
    assert.equal(typeof B.closePopup, 'function');
    assert.equal(typeof B.openPopup, 'function');
  });
}

test('legacy environment: token decoding needs no typed arrays', () => {
  const { ctx } = legacyWindow('legacy');
  ctx.__OVERLAY_BRIDGE_TEST_HOOKS__ = {};
  vm.runInContext(source, ctx);
  const raw = Buffer.alloc(35);
  raw[0] = 0x01;
  raw.writeUInt16BE(51069, 1);
  for (let i = 0; i < 32; i++) raw[3 + i] = i;
  const decoded = ctx.__OVERLAY_BRIDGE_TEST_HOOKS__.decodeToken(raw.toString('base64url'));
  assert.equal(decoded.port, 51069);
  assert.equal(decoded.key, raw.subarray(3).toString('base64url'));
});
