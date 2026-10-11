// Shared test harness: app server + native side (Python stand-in or DLL host) + helpers.
import { before, after } from 'node:test';
import { spawn } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_PORT = 8770;
export const ORIGIN = `http://127.0.0.1:${APP_PORT}`;
export const CONTROL = 'http://127.0.0.1:27081';
// Steam Deck overlay (SteamOS 3.8.28, client 1788652215); Chrome version not seen yet
export const STEAM_DECK_UA = 'Mozilla/5.0 (X11; Linux x86_64; Valve Steam Gamepad [Steam Deck stable]/default/1788652215) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.183 Safari/537.36';
export const STEAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Valve Steam GameOverlay/default/1788652215) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.183 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, what, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}

// Calls to the native side's control port (Python stand-in or DLL host). A failed status throws
// with the body. A transient socket error is retried only when the request cannot have been
// handled (GET, or the connection was refused), so a POST such as /new never runs twice.
export const controlRetries = [];
export async function control(method, p, body) {
  for (let attempt = 1; ; attempt++) {
    let r;
    try {
      r = await fetch(CONTROL + p, { method, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      const code = e.cause?.code || e.message;
      controlRetries.push(`${method} ${p}: ${code}`);
      if (attempt >= 5 || (method !== 'GET' && code !== 'ECONNREFUSED')) throw e;
      await sleep(100);
      continue;
    }
    const text = await r.text();
    if (!r.ok) throw new Error(`control ${method} ${p} -> ${r.status}: ${text}`);
    return JSON.parse(text);
  }
}

export const session = async (id) => (await control('GET', '/status'))[id];

// Starts the static app server and the bridge stand-in; returns stop()
export async function startStack() {
  // A stand-in left running (e.g. from a manual overlay test) would answer instead of ours
  const busy = await fetch(CONTROL + '/status').then(() => true, () => false);
  if (busy) throw new Error(`${CONTROL} is already in use: stop the other bridge stand-in first`);
  const server = await startServer(APP_PORT);
  // BRIDGE_IMPL=dll: the real native SDK bridge DLL (through a ctypes host) instead of the Python stand-in
  const native = process.env.BRIDGE_IMPL === 'dll' ? 'bridge_dll_host.py' : 'bridge_native_standin.py';
  const standin = spawn('python', [path.join(here, native), ORIGIN], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  standin.stdout.on('data', (d) => { log += d; });
  standin.stderr.on('data', (d) => { log += d; });
  await waitFor(() => fetch(CONTROL + '/status').then(() => true, () => false), 'bridge stand-in');
  return {
    log: () => log,
    stop() {
      standin.kill();
      server.close();
      if (controlRetries.length) console.log(`control-port retries (${controlRetries.length}):\n  ${controlRetries.join('\n  ')}`);
    },
  };
}

// Starts the stack and the three browser engines for a test file; closes them after it.
export const ENGINES = { chromium, firefox, webkit };
export function useBrowsers() {
  const browsers = {};
  let stack;
  before(async () => {
    stack = await startStack();
    for (const [name, engine] of Object.entries(ENGINES)) browsers[name] = await engine.launch();
  });
  after(async () => {
    for (const b of Object.values(browsers)) await b.close();
    stack?.stop();
  });
  return browsers;
}

// The close reason once the native side reports the popup closed
export const closedReason = (id) => waitFor(async () => {
  const s = await session(id);
  return s.state === 'closed' && s.close_reason;
}, `popup ${id} closed`, 10000);

// Resolves true when the page closes (itself, or by the native side) within the timeout
export const pageClosed = (page, timeoutMs = 8000) => page.waitForEvent('close', { timeout: timeoutMs }).then(() => true, () => false);

// As if the page were torn down before anything could be sent (crash, or a close notice that
// never gets out): its close-notice senders do nothing from now on
export const disableExitSenders = (page) => page.evaluate(() => {
  navigator.sendBeacon = () => true;
  window.fetch = () => new Promise(() => {});
});

// Adds <a id=.. href=.. target=_blank> at the top of the page
export const addBlankLink = (page, href, id) => page.evaluate(({ href, id }) => {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.id = id;
  a.textContent = id;
  document.body.prepend(a);
}, { href, id });

// Desktop browsers let window.close() close only windows a script opened, so open the page
// as a popup (the Steam overlay itself allows it; verified on the real overlay).
export async function openPopup(context, url) {
  const opener = await context.newPage();
  const [page] = await Promise.all([
    context.waitForEvent('page'),
    opener.evaluate((u) => { window.open(u, '_blank'); }, url),
  ]);
  // A page may close itself before 'load' (auto close of a page that cannot connect): not an error here
  await page.waitForLoadState().catch((e) => { if (!page.isClosed()) throw e; });
  return page;
}

export const PAGE = `${ORIGIN}/vanilla/index.html`;
export const bridgeConnected = (page) =>
  page.waitForFunction(() => window.OverlayBridge && OverlayBridge.isAvailable(), null, { timeout: 10000 });

// Opens a popup the way the game does (Steam overlay UA) and waits until it is connected.
// init: optional script run in the page before its own scripts (page.addInitScript)
export async function openConnected(browsers, engineName, base = PAGE, extraQuery = '', init) {
  const { id, url } = await control('POST', `/new?base=${encodeURIComponent(base)}${extraQuery}`);
  const context = await browsers[engineName].newContext({ userAgent: STEAM_UA });
  if (init) await context.addInitScript(init);
  const page = await openPopup(context, url);
  await bridgeConnected(page);
  return { id, context, page };
}

// Plays the game's part for child popups: opens the pending child of `parentId`
export async function launchChild(context, parentId) {
  const child = await waitFor(async () => (await control('GET', '/pending')).find((p) => p.parent === parentId), `child of ${parentId}`);
  await control('POST', `/launched?id=${child.id}`);
  const page = await openPopup(context, child.url);
  await bridgeConnected(page);
  return { id: child.id, url: child.url, page };
}

// Collects the page's /open requests (child popups it asked the game for)
export function watchOpens(page) {
  const opens = [];
  page.on('request', (r) => { if (r.url().endsWith('/open')) opens.push(r.postData()); });
  return opens;
}
