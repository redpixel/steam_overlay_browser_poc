// overlay-bridge.js inside a real WebView2 control, driven by a test host that uses the same
// WebView2 APIs as the PC launcher. Run: npm run test:webview2  (from tests/)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../frameworks/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8771;
let server;
let result;

before(async () => {
  execFileSync('dotnet', ['build', path.join(here, 'WebView2Host.csproj'), '-c', 'Release', '--nologo', '-v', 'q'], { stdio: 'inherit' });
  server = await startServer(PORT);
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'wv2-')), 'result.json');
  const exe = path.join(here, 'bin', 'Release', 'net10.0-windows', 'WebView2Host.exe');
  try {
    // async: the page server runs in this same process and must keep serving while the host runs
    await promisify(execFile)(exe, [`http://127.0.0.1:${PORT}/vanilla/index.html`, out], { timeout: 60000 });
  } catch (e) {
    // exit code 1 = some step failed and the result file says which; anything else is reported
    console.log(`host exited: status=${e.status} signal=${e.signal} ${e.code || ''} ${e.message.split('\n')[0]}`);
  }
  result = JSON.parse(readFileSync(out, 'utf8'));
});

after(() => server?.close());

test('WebView2 host ran every step', () => {
  assert.ok(result.steps.length >= 10, JSON.stringify(result.steps, null, 1));
});

test('every WebView2 step passed', () => {
  for (const s of result.steps) {
    console.log(`${s.pass ? 'PASS' : 'FAIL'}  ${s.name}  | ${s.detail}`);
  }
  const failed = result.steps.filter((s) => !s.pass);
  assert.deepEqual(failed, []);
});
