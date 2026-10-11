// Ways a page opens a new window, turned into tracked child popups (Steam overlay path): middle
// click, <base target>, SVG links, GET forms; download links and POST forms are left alone.
// Also the 'connected' event. Chromium, Firefox and WebKit with the Steam overlay UA.
// Run: npm run test:frameworks  (from tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES, control, waitFor, sleep, useBrowsers, closedReason, launchChild, watchOpens,
  openConnected as openIn } from './harness.mjs';

const browsers = useBrowsers();
const openConnected = (...args) => openIn(browsers, ...args);

// Adds markup at the top of the page
const addHtml = (page, html) => page.evaluate((h) => { document.body.insertAdjacentHTML('afterbegin', h); }, html);

async function closeAll(parent, ...children) {
  await control('POST', `/close?id=${parent.id}`);
  await closedReason(parent.id);
  for (const c of children) await closedReason(c.id);
  await parent.context.close();
}

// The child the game was asked to open: its address, and no window of its own besides the popup
async function expectChild(parent, search) {
  const child = await launchChild(parent.context, parent.id);
  assert.equal(await child.page.evaluate(() => location.search), search);
  const own = parent.context.pages().filter((p) => p !== child.page && p.url().includes(search));
  assert.deepEqual(own.map((p) => p.url()), [], 'the browser did not also open its own window');
  assert.equal(parent.page.url().includes('child='), false, 'the parent did not navigate');
  return child;
}

for (const engineName of Object.keys(ENGINES)) {
  test(`[${engineName}] a middle click on a link opens a tracked child popup`, async () => {
    const parent = await openConnected(engineName);
    await addHtml(parent.page, '<a id="l" href="/vanilla/index.html?child=middle">middle</a>');
    await parent.page.click('#l', { button: 'middle' });
    const child = await expectChild(parent, '?child=middle');
    await closeAll(parent, child);
  });

  test(`[${engineName}] a link without target under <base target="_blank"> opens a tracked child popup`, async () => {
    const parent = await openConnected(engineName);
    await parent.page.evaluate(() => {
      const base = document.createElement('base');
      base.target = '_blank';
      document.head.appendChild(base);
    });
    await addHtml(parent.page, '<a id="l" href="/vanilla/index.html?child=base">base</a>');
    await parent.page.click('#l');
    const child = await expectChild(parent, '?child=base');
    await closeAll(parent, child);
  });

  test(`[${engineName}] an SVG link with target="_blank" opens a tracked child popup`, async () => {
    const parent = await openConnected(engineName);
    await addHtml(parent.page, '<svg width="120" height="40" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<a id="l" xlink:href="/vanilla/index.html?child=svg" target="_blank"><rect width="120" height="40" fill="blue"/></a></svg>');
    await parent.page.click('#l rect');
    const child = await expectChild(parent, '?child=svg');
    await closeAll(parent, child);
  });

  test(`[${engineName}] a GET form with target="_blank" opens its result as a tracked child popup`, async () => {
    const parent = await openConnected(engineName);
    await addHtml(parent.page, '<form id="f" action="/vanilla/index.html?dropped=1#frag" target="_blank">' +
      '<input name="child" value="form"><input name="q" value="a b"><button id="go">go</button></form>');
    await parent.page.click('#go');
    const child = await expectChild(parent, '?child=form&q=a+b');
    assert.equal(await child.page.evaluate(() => location.hash), '#frag', 'the action fragment is kept');
    await closeAll(parent, child);
  });

  test(`[${engineName}] download links and POST forms with target="_blank" are left to the browser`, async () => {
    const parent = await openConnected(engineName);
    const opens = watchOpens(parent.page);
    await addHtml(parent.page, '<a id="d" href="/vanilla/index.html?child=download" download target="_blank">dl</a>' +
      '<form id="f" method="post" action="/vanilla/index.html?child=post" target="_blank"><button id="go">go</button></form>');
    const download = parent.page.waitForEvent('download', { timeout: 5000 }).then((d) => d.cancel(), () => {});
    await parent.page.click('#d');
    await download;
    const postWindow = parent.context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await parent.page.click('#go');
    const w = await postWindow;
    assert.ok(w, 'the POST form opened its own window');
    await w.close();
    await sleep(300);
    assert.deepEqual(opens, [], 'no /open request');
    await closeAll(parent);
  });

  test(`[${engineName}] 'connected' fires once the bridge is up; a listener added later is called once`, async () => {
    // Registered before the page connects (overlaybridge:ready fires when overlay-bridge.js loads)
    const parent = await openConnected(engineName, undefined, '', () => {
      window.__connectedEvents = 0;
      window.addEventListener('overlaybridge:ready', () => {
        OverlayBridge.addEventListener('connected', () => { window.__connectedEvents++; });
      });
    });
    await waitFor(() => parent.page.evaluate(() => window.__connectedEvents === 1), 'connected event');
    const late = await parent.page.evaluate(() => new Promise((resolve) => {
      let n = 0;
      OverlayBridge.addEventListener('connected', () => { n++; });
      setTimeout(() => resolve(n), 300);
    }));
    assert.equal(late, 1, 'late listener called once');
    assert.equal(await parent.page.evaluate(() => window.__connectedEvents), 1, 'early listener not called again');
    await closeAll(parent);
  });
}
