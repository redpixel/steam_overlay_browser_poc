// Framework compatibility of the '#ovbk=<token>' launch parameter.
//
// For vanilla JS, React (React Router 7) and Vue 2 / Vue 3 (Vue Router 3 / 4), in history and hash
// routing modes, on Chromium, Firefox and WebKit:
//   Steam overlay UA: the native side (Python stand-in with ovb_token.dll, or the DLL) builds the popup URL,
//     overlay-bridge.js strips the token before the router starts, the router shows the intended
//     route, ping/pong works, in-app navigation keeps the connection, a native close closes the page.
//   Normal UA: no localhost connection is attempted and the router is unaffected.
//
// Run: npm run test:frameworks  (from tests/; needs the apps built and native_bridge built)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, STEAM_UA, STEAM_DECK_UA, ENGINES, sleep, control, session, waitFor, openPopup, useBrowsers, closedReason } from './harness.mjs';

// [name, page URL the game opens, expected router state, in-app navigation target]
const CASES = [
  ['vanilla plain', '/vanilla/index.html?tab=2', { path: '/vanilla/index.html', query: { tab: '2' }, hash: '' }, '/vanilla/index.html?tab=3'],
  ['vanilla plain + anchor', '/vanilla/index.html?tab=2#section-3', { path: '/vanilla/index.html', query: { tab: '2' }, hash: '#section-3' }, '/vanilla/index.html?tab=3'],
  ['vanilla hash router', '/vanilla/hashrouter.html#/event/7?tab=2', { path: '/event/7', id: '7', query: { tab: '2' } }, '/event/8'],
  ['vanilla hash router, no route', '/vanilla/hashrouter.html', { path: '/' }, '/event/8'],
];
for (const fw of ['react', 'vue2', 'vue3']) {
  CASES.push(
    [`${fw} history`, `/${fw}/event/7?tab=2`, { path: '/event/7', id: '7', query: { tab: '2' }, hash: '' }, '/event/8'],
    [`${fw} history + anchor`, `/${fw}/event/7?tab=2#section-3`, { path: '/event/7', id: '7', query: { tab: '2' }, hash: '#section-3' }, '/event/8'],
    [`${fw} hash`, `/${fw}/hash.html#/event/7?tab=2`, { path: '/event/7', id: '7', query: { tab: '2' } }, '/event/8'],
    [`${fw} hash, no route`, `/${fw}/hash.html`, { path: '/' }, '/event/8'],
  );
}

const browsers = useBrowsers();

const pongs = async (id) => (await session(id)).web_messages.filter((m) => m && m.cmd === 'pong');

function assertRoute(actual, expected, label) {
  for (const [k, v] of Object.entries(expected)) {
    assert.deepEqual(actual[k], v, `${label}: router ${k}`);
  }
}

for (const engineName of Object.keys(ENGINES)) {
  for (const [name, pagePath, expected, navTarget] of CASES) {
    test(`[${engineName}] Steam overlay: ${name}`, async () => {
      const { id, url } = await control('POST', `/new?base=${encodeURIComponent(ORIGIN + pagePath)}`);
      assert.match(url, /[#&]ovbk=[A-Za-z0-9_-]{47}$/, 'C library appended the token');

      const context = await browsers[engineName].newContext({ userAgent: STEAM_UA });
      const page = await openPopup(context, url);
      try {
        await page.waitForFunction(() => window.OverlayBridge.isAvailable() && window.__routerState, null, { timeout: 10000 });

        const s = await page.evaluate(() => ({ env: OverlayBridge.getEnvironment(), href: location.href, route: window.__routerState }));
        assert.equal(s.env, 'steam-overlay');
        assert.equal(await page.evaluate(() => OverlayBridge.getPopupId()), id, 'page knows its popup id');
        assert.ok(!s.href.includes('ovbk'), `token stripped from the address: ${s.href}`);
        assert.ok(!JSON.stringify(s.route).includes('ovbk'), 'router never saw the token');
        assertRoute(s.route, expected, name);

        // native -> web -> native
        await control('POST', `/send?id=${id}`, { cmd: 'ping', n: 1 });
        const [p1] = await waitFor(async () => { const p = await pongs(id); return p.length >= 1 && p; }, 'pong 1');
        assert.equal(p1.echo.n, 1);

        // in-app navigation keeps the same connection
        const before = await page.evaluate(() => JSON.stringify(window.__routerState));
        await page.evaluate((t) => window.__testNavigate(t), navTarget);
        await page.waitForFunction((b) => JSON.stringify(window.__routerState) !== b, before, { timeout: 5000 });
        await control('POST', `/send?id=${id}`, { cmd: 'ping', n: 2 });
        const p2 = await waitFor(async () => { const p = await pongs(id); return p.length >= 2 && p[1]; }, 'pong 2');
        assert.equal(p2.echo.n, 2);
        assert.equal((await session(id)).key_used, true);

        // native close -> page closes itself -> bridge detects it
        const closed = page.waitForEvent('close', { timeout: 8000 }).then(() => true, () => false);
        await control('POST', `/close?id=${id}`);
        assert.equal(await closed, true, 'window.close() closed the page');
        assert.equal(await closedReason(id), 'NATIVE_REQUEST');
      } finally {
        await context.close();
      }
    });

    test(`[${engineName}] normal browser: ${name}`, async () => {
      const before = Object.keys(await control('GET', '/status')).length;
      const context = await browsers[engineName].newContext();
      const page = await context.newPage();
      const localRequests = [];
      page.on('request', (r) => { if (/^http:\/\/127\.0\.0\.1:(?!8770)/.test(r.url())) localRequests.push(r.url()); });
      try {
        await page.goto(ORIGIN + pagePath);
        await page.waitForFunction(() => window.__routerState, null, { timeout: 10000 });
        const s = await page.evaluate(() => ({ env: OverlayBridge.getEnvironment(), route: window.__routerState }));
        assert.equal(s.env, 'none');
        assert.equal(await page.evaluate(() => OverlayBridge.getPopupId()), null);
        assertRoute(s.route, expected, name);
        assert.equal(await page.evaluate(() => OverlayBridge.postMessage({ cmd: 'x' })), false);
        assert.deepEqual(localRequests, [], 'no localhost bridge requests');
        assert.equal(Object.keys(await control('GET', '/status')).length, before);
      } finally {
        await context.close();
      }
    });
  }
}

// Steam Deck overlay User-Agent ("Valve Steam Gamepad") takes the Steam path too
for (const engineName of Object.keys(ENGINES)) {
  test(`[${engineName}] Steam Deck overlay UA connects`, async () => {
    const pagePath = CASES[0][1];
    const { id, url } = await control('POST', `/new?base=${encodeURIComponent(ORIGIN + pagePath)}`);
    const context = await browsers[engineName].newContext({ userAgent: STEAM_DECK_UA });
    const page = await openPopup(context, url);
    try {
      await page.waitForFunction(() => window.OverlayBridge.isAvailable(), null, { timeout: 10000 });
      assert.equal(await page.evaluate(() => OverlayBridge.getEnvironment()), 'steam-overlay');
      await control('POST', `/send?id=${id}`, { cmd: 'ping', n: 1 });
      const [p1] = await waitFor(async () => { const p = await pongs(id); return p.length >= 1 && p; }, 'pong');
      assert.equal(p1.echo.n, 1);
      await control('POST', `/close?id=${id}`);
      assert.equal(await closedReason(id), 'NATIVE_REQUEST');
    } finally {
      await context.close();
    }
  });
}
