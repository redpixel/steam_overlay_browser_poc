// Native-side protocol checks without a browser: the test talks to a popup's bridge server
// directly (port and key decoded from the launch token in the /new URL), so it runs against the
// Python stand-in and the DLL alike (BRIDGE_IMPL=dll). Covers the security checks, /open URL
// validation, JSON passed through unchanged and the reconnect grace period.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ORIGIN, CONTROL, control, session, waitFor, startStack, sleep, closedReason } from './harness.mjs';

const GRACE_MS = 1000;   // native side: a dropped stream may come back within this

let stack;
before(async () => { stack = await startStack(); });
after(() => stack?.stop());

// Port and one-time key from #ovbk=base64url(0x01 | port BE16 | key[32])
function launchInfo(url) {
  const raw = Buffer.from(new URL(url).hash.match(/ovbk=([A-Za-z0-9_-]{47})/)[1], 'base64url');
  return { port: raw.readUInt16BE(1), key: raw.subarray(3).toString('base64url') };
}

// One raw request to a bridge server. A connection the server drops without answering gives status 0.
function request(port, { method = 'POST', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { Origin: ORIGIN, ...headers };
    if (data !== undefined) Object.assign(h, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(data) }, headers);
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', (e) => (['ECONNRESET', 'EPIPE'].includes(e.code) ? resolve({ status: 0 }) : reject(e)));
    req.end(data);
  });
}
const post = (port, path, body) => request(port, { path, body });

// Opens /events. events() parses what arrived; next(name) waits for the next such event.
function openStream(port, sid) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/events?sid=${encodeURIComponent(sid)}`, headers: { Origin: ORIGIN } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`/events -> ${res.statusCode}`));
      let text = '';
      let taken = 0;
      const parsed = () => text.split('\n\n').slice(0, -1).map((block) => {
        const lines = block.split('\n');
        const event = (lines.find((l) => l.startsWith('event: ')) || '').slice(7);
        const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        return { event, data, retry: (lines.find((l) => l.startsWith('retry: ')) || '').slice(7) };
      });
      const stream = {
        raw: () => text,
        destroy: () => req.destroy(),
        next: (name) => waitFor(() => {
          const all = parsed().filter((e) => e.event === name);
          if (all.length > taken) return all[taken++];
          return null;
        }, `event ${name}`, 5000),
      };
      res.on('data', (d) => { text += d; });
      res.once('data', () => resolve(stream));
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}

async function newPopup() {
  const { id, url } = await control('POST', `/new?base=${encodeURIComponent(`${ORIGIN}/vanilla/index.html`)}`);
  return { id, ...launchInfo(url) };
}

async function connectedPopup() {
  const p = await newPopup();
  const r = await post(p.port, '/connect', { key: p.key });
  assert.equal(r.status, 200, 'connect');
  return { ...p, sid: JSON.parse(r.body).sid };
}

async function closeAndWait(id) {
  await control('POST', `/close?id=${id}`);
  await closedReason(id);
}

// --- reconnect grace period ----------------------------------------------------------------

test('the stream tells EventSource to retry well within the grace period', async () => {
  const p = await connectedPopup();
  const stream = await openStream(p.port, p.sid);
  const retry = Number((stream.raw().match(/retry: (\d+)/) || [])[1]);
  assert.ok(retry > 0 && retry <= GRACE_MS / 2, `retry ${retry} ms vs grace ${GRACE_MS} ms`);
  stream.destroy();
  assert.equal(await closedReason(p.id), 'CONNECTION_LOST');
});

test('a stream that comes back within the grace period keeps the popup open', async () => {
  const p = await connectedPopup();
  let stream = await openStream(p.port, p.sid);
  await waitFor(async () => (await session(p.id)).state === 'open', 'open');
  stream.destroy();
  await sleep(300);                          // an EventSource retry
  stream = await openStream(p.port, p.sid);
  await sleep(GRACE_MS + 500);
  assert.equal((await session(p.id)).state, 'open', 'still open after the grace period');
  stream.destroy();                          // gone for good this time
  assert.equal(await closedReason(p.id), 'CONNECTION_LOST');
});

// --- security checks ---------------------------------------------------------------------------

test('requests with a wrong Host (DNS rebinding) or a missing / other Origin are refused', async () => {
  const p = await newPopup();
  const connect = { path: '/connect', body: { key: p.key } };
  assert.equal((await request(p.port, { ...connect, headers: { Host: `evil.example:${p.port}` } })).status, 403, 'bad Host');
  assert.equal((await request(p.port, { ...connect, headers: { Origin: null } })).status, 403, 'no Origin');
  assert.equal((await request(p.port, { ...connect, headers: { Origin: 'https://evil.example' } })).status, 403, 'other Origin');
  assert.equal((await request(p.port, { method: 'OPTIONS', path: '/connect', headers: { Origin: 'https://evil.example' } })).status, 403, 'preflight, other Origin');
  // none of these used the key
  assert.equal((await post(p.port, '/connect', { key: p.key })).status, 200, 'the real page still connects');
  await closeAndWait(p.id);
});

test('the preflight answers an allowed Origin with the CORS and private-network headers', async () => {
  const p = await newPopup();
  const r = await request(p.port, { method: 'OPTIONS', path: '/connect', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(r.headers['access-control-allow-private-network'], 'true');
  await closeAndWait(p.id);
});

test('the key works once; a wrong key, a bad session and malformed bodies are refused', async () => {
  const p = await newPopup();
  assert.equal((await post(p.port, '/connect', { key: p.key.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) })).status, 403, 'wrong key');
  assert.equal((await post(p.port, '/connect', { key: 'short' })).status, 403, 'short key');
  const ok = await post(p.port, '/connect', { key: p.key });
  assert.equal(ok.status, 200);
  const { sid } = JSON.parse(ok.body);
  assert.equal((await post(p.port, '/connect', { key: p.key })).status, 403, 'key used twice');
  await assert.rejects(openStream(p.port, 'not-the-session'), /403/, 'events with a bad sid');
  assert.equal((await post(p.port, '/message', { sid: 'not-the-session', message: 1 })).status, 403, 'message with a bad sid');
  assert.equal((await post(p.port, '/message', '[1,2]')).status, 403, 'not a JSON object');
  assert.equal((await post(p.port, '/message', '{"sid":')).status, 403, 'not JSON');
  assert.equal((await post(p.port, '/nope', { sid })).status, 403, 'unknown path');
  const big = await post(p.port, '/message', { sid, message: 'x'.repeat(17 * 1024) });
  assert.notEqual(big.status, 200, `body over 16 KB refused (status ${big.status})`);
  assert.equal((await post(p.port, '/message', { sid, message: 'still fine' })).status, 200, 'the session still works');
  await closeAndWait(p.id);
});

// --- /open: only allowed sites ---------------------------------------------------------------------

test('/open accepts only exact allowed origins', async () => {
  const p = await connectedPopup();
  const stream = await openStream(p.port, p.sid);
  const { hostname: host, port } = new URL(ORIGIN);
  for (const url of [
    `http://${host}:${port}.evil.example/x`,          // lookalike host
    `http://${host}:${port}@evil.example/x`,          // userinfo
    `https://${host}:${port}/x`,                      // other scheme
    `http://${host}:${Number(port) + 1}/x`,           // other port
    'javascript:alert(1)',
    'data:text/html,hi',
  ]) {
    assert.equal((await post(p.port, '/open', { sid: p.sid, url })).status, 403, url);
  }
  const ok = await post(p.port, '/open', { sid: p.sid, url: `${ORIGIN}/vanilla/index.html?child=1` });
  assert.equal(ok.status, 200, 'the allowed site');
  const child = JSON.parse(ok.body).popupId;
  stream.destroy();
  await closedReason(p.id);
  assert.equal(await closedReason(child), 'NATIVE_REQUEST', 'the child closes with its parent');
});

// --- JSON passed through unchanged -------------------------------------------------------------

const VALUES = [
  { cmd: 'ping', text: '한글 é 😀', nested: { list: [1, 2.5, -3e-7, null, true] } },
  'just a string',
  42,
  null,
  [{ a: 'line\nbreak' }, '\u0000'],
];

test('web -> native: messages arrive as the same JSON value', async () => {
  const p = await connectedPopup();
  const stream = await openStream(p.port, p.sid);
  for (const message of VALUES) {
    assert.equal((await post(p.port, '/message', { sid: p.sid, message })).status, 200);
  }
  const got = await waitFor(async () => { const m = (await session(p.id)).web_messages; return m.length >= VALUES.length && m; }, 'messages');
  assert.deepEqual(got, VALUES);
  stream.destroy();
  await closedReason(p.id);
});

test('native -> web: messages arrive as the same JSON value, also with CR/LF in the JSON text', async () => {
  const p = await connectedPopup();
  const stream = await openStream(p.port, p.sid);
  await waitFor(async () => (await session(p.id)).state === 'open', 'open');
  for (const value of VALUES) {
    await control('POST', `/send?id=${p.id}`, value);
    assert.deepEqual(JSON.parse((await stream.next('message')).data), value);
  }
  // Pretty-printed JSON from the game, with CRLF and a lone CR between tokens
  const text = '{\r\n  "cmd": "pretty",\r  "n": 1\n}';
  const r = await fetch(`${CONTROL}/send?id=${p.id}`, { method: 'POST', body: text });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse((await stream.next('message')).data), { cmd: 'pretty', n: 1 });
  stream.destroy();
  await closedReason(p.id);
});

// --- child popups ------------------------------------------------------------------------------

// The game's part: shows a pending child (the test connects to it like its page would)
async function connectChild(parentId) {
  const child = await waitFor(async () => (await control('GET', '/pending')).find((p) => p.parent === parentId), `child of ${parentId}`);
  await control('POST', `/launched?id=${child.id}`);
  const { port, key } = launchInfo(child.url);
  const r = await post(port, '/connect', { key });
  assert.equal(r.status, 200, 'child connect');
  const sid = JSON.parse(r.body).sid;
  return { id: child.id, port, sid, stream: await openStream(port, sid) };
}

test('closing a popup closes its children and grandchildren (NATIVE_REQUEST)', async () => {
  const root = await connectedPopup();
  const rootStream = await openStream(root.port, root.sid);
  assert.equal((await post(root.port, '/open', { sid: root.sid, url: `${ORIGIN}/vanilla/index.html?child=1` })).status, 200);
  const child = await connectChild(root.id);
  assert.equal((await post(child.port, '/open', { sid: child.sid, url: `${ORIGIN}/vanilla/index.html?grandchild=1` })).status, 200);
  const grandchild = await connectChild(child.id);
  await control('POST', `/close?id=${root.id}`);
  for (const p of [root, child, grandchild]) {
    const s = p === root ? rootStream : p.stream;
    await s.next('close');      // each page is asked to close itself
    s.destroy();
  }
  assert.equal(await closedReason(root.id), 'NATIVE_REQUEST');
  assert.equal(await closedReason(child.id), 'NATIVE_REQUEST');
  assert.equal(await closedReason(grandchild.id), 'NATIVE_REQUEST');
});

// --- a popup closed while its page is still loading ---------------------------------------------

test('a popup closed before its page connects is reported at once, and the late page is told to close', async () => {
  const p = await newPopup();
  await control('POST', `/close?id=${p.id}`);
  assert.equal(await closedReason(p.id), 'NATIVE_REQUEST', 'reported at once');
  // the page finishes loading now
  const r = await post(p.port, '/connect', { key: p.key });
  assert.equal(r.status, 200, 'the late page can still connect');
  const { sid } = JSON.parse(r.body);
  const stream = await openStream(p.port, sid);
  await stream.next('close');
  assert.equal((await post(p.port, '/message', { sid, message: 'too late' })).status, 403, 'no messages after close');
  assert.deepEqual((await session(p.id)).web_messages, []);
  stream.destroy();
  // once the page is gone the server stops
  await waitFor(() => post(p.port, '/connect', { key: p.key }).then(() => false, () => true), 'server stopped');
  assert.equal((await session(p.id)).close_reason, 'NATIVE_REQUEST', 'reason unchanged');
});

test('/open compares origins the way the browser writes them (case, default port)', async () => {
  const p = await connectedPopup();
  const stream = await openStream(p.port, p.sid);
  const { hostname: host, port } = new URL(ORIGIN);
  const r = await post(p.port, '/open', { sid: p.sid, url: `HTTP://${host}:${port}/vanilla/index.html?child=case` });
  assert.equal(r.status, 200, 'upper-case scheme');
  const child = JSON.parse(r.body).popupId;
  stream.destroy();
  await closedReason(p.id);
  await closedReason(child);
});
