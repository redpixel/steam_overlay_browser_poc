// Static server for the framework test apps (no dependencies).
//   /overlay-bridge.js          test_page/overlay-bridge.js (the script under test)
//   /common/*                 apps/common
//   /vanilla/*                apps/vanilla
//   /react/* /vue2/* /vue3/*  apps/<name>/dist, unknown paths fall back to index.html (history-mode routing)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };

const mounts = [
  ['/overlay-bridge.js', path.join(root, 'test_page', 'overlay-bridge.js'), null],
  ['/common/', path.join(here, 'apps', 'common'), null],
  ['/vanilla/', path.join(here, 'apps', 'vanilla'), null],
  ['/react/', path.join(here, 'apps', 'react', 'dist'), 'index.html'],
  ['/vue2/', path.join(here, 'apps', 'vue2', 'dist'), 'index.html'],
  ['/vue3/', path.join(here, 'apps', 'vue3', 'dist'), 'index.html'],
];

async function fileIfExists(p) {
  try {
    return (await stat(p)).isFile() ? p : null;
  } catch {
    return null;
  }
}

export function startServer(port) {
  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    for (const [prefix, dir, fallback] of mounts) {
      if (prefix.endsWith('/') ? !urlPath.startsWith(prefix) : urlPath !== prefix) continue;
      let file = prefix.endsWith('/') ? path.join(dir, urlPath.slice(prefix.length) || 'index.html') : dir;
      if (!file.startsWith(dir)) break;  // no path traversal
      file = (await fileIfExists(file)) || (fallback && !path.extname(urlPath) ? path.join(dir, fallback) : null);
      if (!file) break;
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(file));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer(Number(process.argv[2] || 8770)).then(() => console.log('listening'));
}
