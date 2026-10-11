// Popup ids, the six close reasons and child popups (Steam overlay path).
// Runs the vanilla test page on Chromium, Firefox and WebKit with the Steam overlay UA.
// The test plays the game's part of opening child popups: it reads the native side's pending
// list and opens those URLs (the real game calls ActivateGameOverlayToWebPage instead).
// Run: npm run test:frameworks  (from tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { ORIGIN, STEAM_UA, ENGINES, PAGE, control, openPopup, session, waitFor, sleep, useBrowsers, closedReason, pageClosed,
  disableExitSenders, addBlankLink, launchChild, watchOpens, openConnected as openIn } from './harness.mjs';

const browsers = useBrowsers();
const openConnected = (...args) => openIn(browsers, ...args);

// A launch token for a port nothing listens on (a server that is gone), with a random key
async function deadToken() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return Buffer.concat([Buffer.from([0x01, port >> 8, port & 0xff]), crypto.randomBytes(32)]).toString('base64url');
}

for (const engineName of Object.keys(ENGINES)) {
  test(`[${engineName}] each popup gets its own id, visible to the page`, async () => {
    const a = await openConnected(engineName);
    const b = await openConnected(engineName);
    try {
      assert.notEqual(a.id, b.id);
      assert.equal(await a.page.evaluate(() => OverlayBridge.getPopupId()), a.id);
      assert.equal(await b.page.evaluate(() => OverlayBridge.getPopupId()), b.id);
      assert.equal(await a.page.evaluate(() => sessionStorage.length), 0, 'no session kept in sessionStorage');
    } finally {
      await control('POST', `/close?id=${a.id}`);
      await control('POST', `/close?id=${b.id}`);
      await closedReason(a.id);
      await closedReason(b.id);
      await a.context.close();
      await b.context.close();
    }
  });

  test(`[${engineName}] NATIVE_REQUEST: game closes the popup`, async () => {
    const { id, context, page } = await openConnected(engineName);
    const closed = pageClosed(page);
    await control('POST', `/close?id=${id}`);
    assert.equal(await closed, true, 'page closed itself');
    assert.equal(await closedReason(id), 'NATIVE_REQUEST');
    await context.close();
  });

  test(`[${engineName}] PAGE_REQUEST: page calls window.close()`, async () => {
    const { id, context, page } = await openConnected(engineName);
    const closed = pageClosed(page);
    await page.evaluate(() => { setTimeout(() => window.close(), 0); });
    assert.equal(await closed, true);
    assert.equal(await closedReason(id), 'PAGE_REQUEST');
    assert.equal((await session(id)).page_notice.reason, 'window.close');
    await context.close();
  });

  test(`[${engineName}] PAGE_REQUEST: page calls OverlayBridge.closePopup(reason)`, async () => {
    const { id, context, page } = await openConnected(engineName);
    const closed = pageClosed(page);
    await page.evaluate(() => { setTimeout(() => OverlayBridge.closePopup('purchase-done'), 0); });
    assert.equal(await closed, true);
    assert.equal(await closedReason(id), 'PAGE_REQUEST');
    assert.equal((await session(id)).page_notice.reason, 'purchase-done');
    await context.close();
  });

  test(`[${engineName}] USER_CLOSED: the window is closed from outside the page (overlay X)`, async () => {
    const { id, context, page } = await openConnected(engineName);
    await page.close();
    assert.equal(await closedReason(id), 'USER_CLOSED');
    // hidden, beforeunload and pagehide notices may each arrive last
    const n = (await session(id)).page_notice;
    assert.ok(['hidden', 'beforeunload', 'pagehide'].includes(n.reason), n.reason);
    assert.equal(n.explicit, false);
    await context.close();
  });

  test(`[${engineName}] USER_CLOSED: torn down after beforeunload, no pagehide (Steam Deck B / Steam button)`, async () => {
    const { id, context, page } = await openConnected(engineName);
    await page.evaluate(() => { window.dispatchEvent(new Event('beforeunload')); });
    await waitFor(async () => (await session(id)).page_notice, 'beforeunload notice');
    // nothing else gets out (no pagehide notice on the Deck)
    await disableExitSenders(page);
    await page.close();
    assert.equal(await closedReason(id), 'USER_CLOSED');
    assert.equal((await session(id)).page_notice.reason, 'beforeunload');
    assert.equal((await session(id)).page_notice.explicit, false);
    await context.close();
  });

  test(`[${engineName}] a cancelled beforeunload does not close the popup; a later window.close() is PAGE_REQUEST`, async () => {
    const { id, context, page } = await openConnected(engineName);
    await page.evaluate(() => { window.dispatchEvent(new Event('beforeunload')); });
    await waitFor(async () => (await session(id)).page_notice, 'beforeunload notice');
    await sleep(1000);
    assert.equal((await session(id)).state, 'open', 'still open, stream kept');
    assert.equal(await page.evaluate(() => OverlayBridge.isAvailable()), true);
    await page.evaluate(() => window.close());
    assert.equal(await closedReason(id), 'PAGE_REQUEST');
    assert.equal((await session(id)).page_notice.reason, 'window.close');
    await context.close();
  });

  // Fakes document.visibilityState for the page (headless pages are always visible)
  const setVisibility = (page, state) => page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);

  test(`[${engineName}] USER_CLOSED: hidden, then torn down with nothing else sent (Steam Deck B button)`, async () => {
    const { id, context, page } = await openConnected(engineName);
    await setVisibility(page, 'hidden');
    await waitFor(async () => (await session(id)).page_notice, 'hidden notice');
    await disableExitSenders(page);
    await page.close();
    assert.equal(await closedReason(id), 'USER_CLOSED');
    assert.equal((await session(id)).page_notice.reason, 'hidden');
    await context.close();
  });

  test(`[${engineName}] hidden and shown again (desktop Shift+Tab) keeps the popup; a later crash is CONNECTION_LOST`, async () => {
    const { id, context, page } = await openConnected(engineName);
    await setVisibility(page, 'hidden');
    await waitFor(async () => (await session(id)).page_notice, 'hidden notice');
    await setVisibility(page, 'visible');
    await sleep(5500);  // past the notice window
    assert.equal((await session(id)).state, 'open');
    assert.equal(await page.evaluate(() => OverlayBridge.isAvailable()), true);
    await disableExitSenders(page);
    await page.close();
    assert.equal(await closedReason(id), 'CONNECTION_LOST');
    await context.close();
  });

  test(`[${engineName}] hidden again after being shown sends a new notice`, async () => {
    const { id, context, page } = await openConnected(engineName);
    await setVisibility(page, 'hidden');
    const first = await waitFor(async () => (await session(id)).page_notice, 'hidden notice 1');
    await setVisibility(page, 'visible');
    await sleep(100);
    await setVisibility(page, 'hidden');
    await waitFor(async () => { const n = (await session(id)).page_notice; return n && n.at > first.at && n; }, 'hidden notice 2');
    await control('POST', `/close?id=${id}`);
    assert.equal(await closedReason(id), 'NATIVE_REQUEST');
    await context.close();
  });

  test(`[${engineName}] CONNECTION_LOST: the page disappears without any notice`, async () => {
    const { id, context, page } = await openConnected(engineName);
    // As if the page crashed: nothing can be sent on the way out (beacons are not routable,
    // so the senders themselves are disabled)
    await disableExitSenders(page);
    await page.close();
    assert.equal(await closedReason(id), 'CONNECTION_LOST');
    assert.equal((await session(id)).page_notice, null);
    await context.close();
  });

  test(`[${engineName}] navigating inside the popup ends it; the next page does not reuse the session`, async () => {
    const { id, context, page } = await openConnected(engineName);
    await page.evaluate(() => { location.href = '/vanilla/index.html?step=2'; });
    await page.waitForFunction(() => location.search === '?step=2' && window.OverlayBridge, null, { timeout: 10000 });
    assert.equal(await closedReason(id), 'USER_CLOSED');
    await sleep(500);
    assert.equal(await page.evaluate(() => OverlayBridge.isAvailable()), false);
    assert.equal(await page.evaluate(() => OverlayBridge.getPopupId()), null);
    await context.close();
  });

  test(`[${engineName}] window.open() opens a tracked child popup through the game`, async () => {
    const parent = await openConnected(engineName);
    assert.equal(await parent.page.evaluate(() => window.open('/vanilla/index.html?child=open')), null, 'window.open returns null');
    const child = await launchChild(parent.context, parent.id);
    assert.equal(await child.page.evaluate(() => OverlayBridge.getPopupId()), child.id);
    assert.equal((await session(child.id)).parent, parent.id);
    await control('POST', `/close?id=${child.id}`);
    assert.equal(await closedReason(child.id), 'NATIVE_REQUEST');
    assert.equal((await session(parent.id)).state, 'open', 'parent untouched');
    await control('POST', `/close?id=${parent.id}`);
    await closedReason(parent.id);
    await parent.context.close();
  });

  test(`[${engineName}] target="_blank" link opens a tracked child popup through the game`, async () => {
    const parent = await openConnected(engineName);
    await addBlankLink(parent.page, '/vanilla/index.html?child=link', 'child-link');
    await parent.page.click('#child-link');
    const child = await launchChild(parent.context, parent.id);
    const linkWindows = parent.context.pages().filter((p) => p.url().includes('child=link'));
    assert.equal(linkWindows.length, 1, 'the link did not also open its own window');
    assert.equal(await child.page.evaluate(() => location.search), '?child=link');
    await control('POST', `/close?id=${parent.id}`);
    await closedReason(parent.id);
    await parent.context.close();
  });

  test(`[${engineName}] a link the page opens itself (onclick window.open + preventDefault) opens one popup, not two`, async () => {
    const parent = await openConnected(engineName);
    const opens = watchOpens(parent.page);
    await parent.page.evaluate(() => {
      const a = document.createElement('a');
      a.href = '/vanilla/index.html?child=self';
      a.target = '_blank';
      a.id = 'self-link';
      a.textContent = 'opens itself';
      a.addEventListener('click', (e) => { e.preventDefault(); window.open(a.href); });
      document.body.prepend(a);
    });
    await parent.page.click('#self-link');
    const child = await launchChild(parent.context, parent.id);
    await sleep(500);
    assert.equal(opens.length, 1, 'one /open request');
    assert.deepEqual((await control('GET', '/pending')).filter((p) => p.parent === parent.id), [], 'no second child waiting');
    await control('POST', `/close?id=${parent.id}`);
    await closedReason(parent.id);
    await closedReason(child.id);
    await parent.context.close();
  });

  test(`[${engineName}] closing twice in a row (closePopup then window.close) is still PAGE_REQUEST with the first reason`, async () => {
    const { id, context, page } = await openConnected(engineName);
    const closed = pageClosed(page);
    await page.evaluate(() => { setTimeout(() => { OverlayBridge.closePopup('first'); window.close(); }, 0); });
    assert.equal(await closed, true, 'page closed');
    assert.equal(await closedReason(id), 'PAGE_REQUEST');
    assert.equal((await session(id)).page_notice.reason, 'first');
    await context.close();
  });

  test(`[${engineName}] window.open with a named target is not turned into a popup`, async () => {
    const parent = await openConnected(engineName);
    const opens = watchOpens(parent.page);
    const result = await parent.page.evaluate(() => {
      const w = window.open('/vanilla/index.html?child=named', 'payWindow');
      const ok = w !== null;
      if (w) w.close();
      return ok;
    });
    await sleep(500);
    assert.equal(result, true, 'a real window object is returned');
    assert.deepEqual(opens, [], 'no /open request');
    await control('POST', `/close?id=${parent.id}`);
    await closedReason(parent.id);
    await parent.context.close();
  });

  test(`[${engineName}] a page with <base href> on another origin still connects (token removal does not throw)`, async () => {
    const { id, context, page } = await openConnected(engineName, `${ORIGIN}/vanilla/basehref.html`);
    const s = await page.evaluate(() => ({ env: OverlayBridge.getEnvironment(), href: location.href }));
    assert.equal(s.env, 'steam-overlay');
    assert.ok(!s.href.includes('ovbk'), `token removed: ${s.href}`);
    assert.ok(s.href.startsWith(`${ORIGIN}/vanilla/basehref.html`), `address unchanged otherwise: ${s.href}`);
    await control('POST', `/send?id=${id}`, { cmd: 'ping', n: 7 });
    await waitFor(async () => (await session(id)).web_messages.some((m) => m && m.cmd === 'pong'), 'pong');
    await control('POST', `/close?id=${id}`);
    assert.equal(await closedReason(id), 'NATIVE_REQUEST');
    await context.close();
  });

  test(`[${engineName}] the game can say no popups can be opened (Steam Deck): nothing is asked or opened`, async () => {
    const parent = await openConnected(engineName, PAGE, '&can_open_popup=0');
    const opens = watchOpens(parent.page);
    assert.equal(await parent.page.evaluate(() => OverlayBridge.canOpenPopup()), false);
    assert.equal(await parent.page.evaluate(() => window.open('/vanilla/index.html?child=open')), null, 'window.open returns null');
    assert.equal(await parent.page.evaluate(() => OverlayBridge.openPopup('/vanilla/index.html?child=api')), null, 'openPopup resolves null');
    await addBlankLink(parent.page, '/vanilla/index.html?child=link', 'child-link');
    await parent.page.click('#child-link');
    await sleep(500);
    assert.deepEqual(opens, [], 'no /open request');
    assert.deepEqual((await control('GET', '/pending')).filter((p) => p.parent === parent.id), [], 'nothing for the game to open');
    assert.deepEqual(parent.context.pages().filter((p) => p.url().includes('child=')).map((p) => p.url()), [], 'no window opened');
    assert.equal(parent.page.url().includes('child='), false, 'the parent did not navigate');
    await control('POST', `/close?id=${parent.id}`);
    await closedReason(parent.id);
    await parent.context.close();
  });

  test(`[${engineName}] canOpenPopup() is true where the game allows popups`, async () => {
    const parent = await openConnected(engineName);
    assert.equal(await parent.page.evaluate(() => OverlayBridge.canOpenPopup()), true);
    await control('POST', `/close?id=${parent.id}`);
    await closedReason(parent.id);
    await parent.context.close();
  });

  test(`[${engineName}] closing the parent closes its children (NATIVE_REQUEST)`, async () => {
    const parent = await openConnected(engineName);
    const childId = await parent.page.evaluate(() => OverlayBridge.openPopup('/vanilla/index.html?child=api'));
    const child = await launchChild(parent.context, parent.id);
    assert.equal(child.id, childId, 'openPopup resolves to the new id');
    const childClosed = pageClosed(child.page);
    await parent.page.evaluate(() => { setTimeout(() => OverlayBridge.closePopup('done'), 0); });
    assert.equal(await closedReason(parent.id), 'PAGE_REQUEST');
    assert.equal(await childClosed, true, 'child page closed itself');
    assert.equal(await closedReason(child.id), 'NATIVE_REQUEST');
    await parent.context.close();
  });

  test(`[${engineName}] the game refuses child popups for sites outside its allow list`, async () => {
    const parent = await openConnected(engineName);
    assert.equal(await parent.page.evaluate(() => OverlayBridge.openPopup('https://example.com/')), null);
    // The refusal (403, no CORS headers) is a failed request in Chromium/WebKit, a response in Firefox
    const settled = new Promise((resolve) => {
      const done = (r) => { if (r.url().endsWith('/open')) resolve(); };
      parent.page.on('requestfinished', done);
      parent.page.on('requestfailed', done);
    });
    assert.equal(await parent.page.evaluate(() => window.open('https://example.com/')), null);
    await settled;
    assert.deepEqual((await control('GET', '/pending')).filter((p) => p.parent === parent.id), []);
    await control('POST', `/close?id=${parent.id}`);
    await closedReason(parent.id);
    await parent.context.close();
  });

  test(`[${engineName}] a page whose launch token leads nowhere closes itself (Steam showing an old request)`, async () => {
    const context = await browsers[engineName].newContext({ userAgent: STEAM_UA });
    const page = await openPopup(context, `${PAGE}#ovbk=${await deadToken()}`);
    // 3 tries; a refused connection takes ~2 s each in Firefox / WebKit on Windows (Chromium: ms)
    assert.equal(await pageClosed(page, 10000), true, 'closed itself');
    await context.close();
  });

  test(`[${engineName}] a page whose key the game refuses closes itself`, async () => {
    const { id, url } = await control('POST', `/new?base=${encodeURIComponent(PAGE)}`);
    const context = await browsers[engineName].newContext({ userAgent: STEAM_UA });
    // characters 0-3 carry the version and port; change one inside the key
    const wrongKey = url.replace(/ovbk=([A-Za-z0-9_-]{10})([A-Za-z0-9_-])/, (m, head, c) => `ovbk=${head}${c === 'A' ? 'B' : 'A'}`);
    const page = await openPopup(context, wrongKey);
    assert.equal(await pageClosed(page, 5000), true, 'closed itself');
    await control('POST', `/close?id=${id}`);
    await closedReason(id);
    await context.close();
  });

  test(`[${engineName}] data-auto-close="false" keeps such a page open, not connected`, async () => {
    const context = await browsers[engineName].newContext({ userAgent: STEAM_UA });
    const page = await openPopup(context, `${ORIGIN}/vanilla/noautoclose.html#ovbk=${await deadToken()}`);
    assert.equal(await pageClosed(page, 3000), false, 'still open');
    assert.deepEqual(await page.evaluate(() => [OverlayBridge.getEnvironment(), OverlayBridge.isAvailable()]), ['steam-overlay', false]);
    await context.close();
  });

  test(`[${engineName}] /closing with another popup's id is rejected`, async () => {
    const { id, context, page } = await openConnected(engineName);
    // learn this page's bridge port and session from its own /closing request, without sending it
    let captured;
    await context.route('**/closing', (route) => { captured = { url: route.request().url(), body: route.request().postData() }; route.abort(); });
    await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide')); });
    await waitFor(() => captured, 'captured /closing');
    const { sid } = JSON.parse(captured.body);
    const post = (body) => fetch(captured.url, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' }, body: JSON.stringify(body),
    }).then((r) => r.status);
    assert.equal(await post({ sid, popupId: id + 1000, reason: 'x', explicit: true }), 403, 'wrong popupId');
    assert.equal(await post({ sid: 'nope', popupId: id, reason: 'x', explicit: true }), 403, 'wrong sid');
    assert.equal((await session(id)).page_notice, null);
    await control('POST', `/close?id=${id}`);
    await closedReason(id);
    await context.close();
  });
}

test('NEVER_CONNECTED: the page never connects', async () => {
  const { id } = await control('POST', `/new?base=${encodeURIComponent(PAGE)}&connect_timeout=1.5`);
  assert.equal(await closedReason(id), 'NEVER_CONNECTED');
});

test('SHUTDOWN: game shuts the bridge down with popups open', async () => {
  const a = await openConnected('chromium');
  const b = await openConnected('chromium');
  const { id: waitingId } = await control('POST', `/new?base=${encodeURIComponent(PAGE)}`);
  const closedA = pageClosed(a.page);
  await control('POST', '/shutdown');
  assert.equal(await closedA, true, 'open popups close themselves');
  assert.equal(await closedReason(a.id), 'SHUTDOWN');
  assert.equal(await closedReason(b.id), 'SHUTDOWN');
  assert.equal(await closedReason(waitingId), 'SHUTDOWN');
  await a.context.close();
  await b.context.close();
});
