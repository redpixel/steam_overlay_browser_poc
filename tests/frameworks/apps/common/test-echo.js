// Test-only helper loaded right after overlay-bridge.js in every test app.
// Each app keeps window.__routerState = { path, query, hash, id } up to date (what ITS router sees)
// and window.__testNavigate(path) for an in-app navigation.
// When the native side sends {cmd:'ping'}, reply with what the router currently shows.
(function () {
  window.__bridgeLog = [];
  OverlayBridge.addEventListener('message', function (e) {
    window.__bridgeLog.push(e.data);
    if (e.data && e.data.cmd === 'ping') {
      OverlayBridge.postMessage({ cmd: 'pong', echo: e.data, route: window.__routerState || null });
    }
  });
})();
