// Unit tests for the launch token: C encoder (native_bridge) <-> JS decoder (overlay-bridge.js).
// Run: npm run test:unit   (needs native_bridge\out\ovb_vectors.exe from native_bridge\build.ps1)
// Node's Buffer is the independent reference encoder for base64url( 0x01 | port BE | key[32] ).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Load overlay-bridge.js in a minimal fake browser to reach its internal codec
function loadBridgeHooks() {
  const hooks = {};
  const ctx = {
    navigator: { userAgent: 'unit-test' },
    __OVERLAY_BRIDGE_TEST_HOOKS__: hooks,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    dispatchEvent() {},
  };
  ctx.window = ctx;
  vm.runInNewContext(readFileSync(path.join(root, 'test_page', 'overlay-bridge.js'), 'utf8'), ctx);
  return hooks;
}

const { decodeToken, splitFragment } = loadBridgeHooks();
const vectors = JSON.parse(execFileSync(path.join(root, 'native_bridge', 'out', 'ovb_vectors.exe'), { encoding: 'utf8' }));
const reference = (port, keyHex) => {
  const raw = Buffer.alloc(35);
  raw[0] = 0x01;
  raw.writeUInt16BE(port, 1);
  Buffer.from(keyHex, 'hex').copy(raw, 3);
  return raw.toString('base64url');
};
const keyB64 = (keyHex) => Buffer.from(keyHex, 'hex').toString('base64url');

test('C self-checks passed', () => {
  assert.equal(vectors.selfCheckFailures, 0);
});

test('token: C output equals the independent reference encoding', () => {
  for (const v of vectors.tokens) {
    assert.equal(v.token, reference(v.port, v.key), `port ${v.port}`);
    assert.match(v.token, /^[A-Za-z0-9_-]{47}$/, 'URL-safe, 47 chars, no padding');
  }
});

test('token: JS decodes C tokens to the same port and key', () => {
  for (const v of vectors.tokens) {
    assert.deepEqual({ ...decodeToken(v.token) }, { port: v.port, key: keyB64(v.key) });
  }
});

test('token: malformed or foreign tokens are rejected', () => {
  const good = vectors.tokens[0].token;
  const withVersion = (b) => { const raw = Buffer.from(good, 'base64url'); raw[0] = b; return raw.toString('base64url'); };
  const withPort0 = (() => { const raw = Buffer.from(good, 'base64url'); raw.writeUInt16BE(0, 1); return raw.toString('base64url'); })();
  assert.equal(decodeToken(withVersion(0x02)), null, 'unknown version');
  assert.equal(decodeToken(withPort0), null, 'port 0');
  assert.equal(decodeToken(good.slice(0, 46)), null, 'too short');
  assert.equal(decodeToken(good + 'AAAA'), null, 'too long');
  assert.equal(decodeToken(good.replace(/.$/, '=')), null, 'padding / not base64url');
  assert.equal(decodeToken(good.replace(/.$/, '+')), null, 'standard base64 char');
  assert.equal(decodeToken(''), null);
  assert.equal(decodeToken(undefined), null);
});

test('URL builder: token is appended to the fragment, the page URL is untouched', () => {
  for (const { in: input, out } of vectors.urls) {
    const hashAt = input.indexOf('#');
    const expectedPrefix = hashAt === -1 ? input + '#ovbk=' : input + '&ovbk=';
    assert.ok(out.startsWith(expectedPrefix), `${input} -> ${out}`);
    assert.equal(out.length, expectedPrefix.length + 47);

    const u = new URL(out);
    const original = new URL(input);
    assert.equal(u.pathname + u.search, original.pathname + original.search, 'path and query unchanged');
    const { token, rest } = splitFragment(u.hash);
    assert.equal(rest, hashAt === -1 ? '' : input.slice(hashAt + 1), 'page fragment restored exactly');
    assert.equal(decodeToken(token).port, 51069);
  }
});

test('splitFragment: only our parameter is removed, everything else byte-for-byte', () => {
  const cases = [
    ['#ovbk=T', 'T', ''],
    ['#/event&ovbk=T', 'T', '/event'],
    ['#/event?tab=2&ovbk=T', 'T', '/event?tab=2'],
    ['#section-3&ovbk=T', 'T', 'section-3'],
    ['#/a%20b?x=%2F&y=1&ovbk=T', 'T', '/a%20b?x=%2F&y=1'],
    ['#/event?ovbk_portal=keep&ovbk=T', 'T', '/event?ovbk_portal=keep'],
    ['#/event?ovbkx=1&ovbk=T', 'T', '/event?ovbkx=1'],
    ['#&ovbk=T', 'T', ''],
    ['#!/hashbang&ovbk=T', 'T', '!/hashbang'],
    ['#/no-bridge', null, '/no-bridge'],
    ['', null, ''],
  ];
  for (const [hash, token, rest] of cases) {
    const r = splitFragment(hash);
    assert.equal(r.rest, rest, hash);
    assert.equal(r.token, token, hash);
  }
});
