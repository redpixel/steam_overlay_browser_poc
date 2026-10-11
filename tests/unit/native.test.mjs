// The bridge DLL from the game's side, without Steam or a browser (Windows):
//   - its C API (tests/dll/api_check.py through ctypes)
//   - a game linked with the import library runs without steam_api64.dll (feature off)
//   - a game using ovb_bridge_loader.h runs with the DLL (feature off without Steam) and without it
//   - the Steam path against a fake steam_api64.dll (overlay off / on, Steam Deck, Steam not ready)
//   - a game that exits, or unloads the DLL, without OVB_Shutdown does not crash
// Run: npm run test:unit   (needs native_bridge\build.ps1 outputs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(root, 'native_bridge', 'out');
const windowsOnly = { skip: process.platform !== 'win32' && 'Windows only' };

function run(exe, args = []) {
  const r = spawnSync(exe, args, { encoding: 'utf8' });
  return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

test('C API: argument and state errors, JSON checks, limits, shutdown and re-init', windowsOnly, () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const output = execFileSync(python, [path.join(root, 'tests', 'dll', 'api_check.py')], { encoding: 'utf8' });
  assert.match(output, /0 failure\(s\)/);
});

test('a game linked with the import library runs without steam_api64.dll', windowsOnly, () => {
  const r = run(path.join(out, 'nosteam_game.exe'));
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /RESULT: OK/);
});

test('a game using the loader header runs with the DLL (no Steam) and without it', windowsOnly, () => {
  const withDll = run(path.join(out, 'nosteam_game_dynamic.exe'));
  assert.equal(withDll.code, 0, withDll.output);
  assert.match(withDll.output, /DLL \+ headers only, overlay feature off/);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'ovb-nodll-'));
  try {
    copyFileSync(path.join(out, 'nosteam_game_dynamic.exe'), path.join(dir, 'game.exe'));   // no DLL next to it
    const withoutDll = run(path.join(dir, 'game.exe'));
    assert.equal(withoutDll.code, 0, withoutDll.output);
    assert.match(withoutDll.output, /RESULT: OK \(no DLL\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Steam path (fake steam_api64.dll): overlay off is OVB_BRIDGE_ERR_OVERLAY_DISABLED, on opens Modal, Deck turns child popups off', windowsOnly, () => {
  const r = run(path.join(out, 'steam_path_check.exe'));
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /RESULT: OK/);
});

test('a game that exits or unloads the DLL without OVB_Shutdown does not crash', windowsOnly, () => {
  for (const mode of ['exit', 'unload']) {
    const r = run(path.join(out, 'exit_without_shutdown.exe'), [mode]);
    assert.equal(r.code, 0, `${mode}: ${r.output}`);
  }
});
