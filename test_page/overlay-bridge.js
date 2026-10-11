/*!
 * overlay-bridge.js 0.7.4 (PoC)
 *
 * Web <-> native bridge for native SDK popup pages. Load it from the CDN in <head>,
 * without async/defer, before the page's own scripts:
 *
 *   <script src="https://<cdn>/overlay-bridge.js"></script>
 *
 * Same shape as WebView2's window.chrome.webview, so existing code only swaps the object:
 *
 *   OverlayBridge.postMessage(message)                      web -> native (JSON value), Promise<boolean>
 *   OverlayBridge.addEventListener('message', e => e.data)  native -> web
 *   OverlayBridge.addEventListener('close', fn)             the game is closing this popup (Steam overlay)
 *   OverlayBridge.addEventListener('connected', fn)         connected to the game (again after a drop); a listener
 *                                                         added while connected is called once right away (async)
 *   OverlayBridge.removeEventListener(type, fn)
 *   OverlayBridge.getEnvironment()                          'steam-overlay' | 'webview2' | 'none'
 *   OverlayBridge.isAvailable()                             true while connected to the game
 *   OverlayBridge.getPopupId()                              this popup's id from the game (Steam overlay), else null
 *   OverlayBridge.closePopup(reason)                        close this popup and tell the game why (Steam: PAGE_REQUEST)
 *   OverlayBridge.openPopup(url)                            open url as a new popup the game tracks (Steam), Promise<id|null>
 *                                                         (Steam: new-window links, middle clicks, GET forms with
 *                                                         target="_blank" and window.open() do this too)
 *   OverlayBridge.canOpenPopup()                            false where new popups cannot be opened (Steam Deck: the
 *                                                         overlay shows one page at a time); then openPopup(),
 *                                                         window.open(), new-window links and forms do nothing
 *
 * Messages are passed through unchanged. window 'overlaybridge:ready' fires once the API is installed.
 *
 * A page the game opened (launch token in the address) that cannot connect to the game closes
 * itself: no server behind the token, or the key refused (e.g. Steam showing a request left
 * from an earlier run). To keep such a page open:
 *   <script src="https://<cdn>/overlay-bridge.js" data-auto-close="false"></script>
 *
 * Environments (checked in this order):
 *   steam-overlay  Steam overlay browser. User-Agent contains "Valve Steam GameOverlay" (desktop
 *                  Steam, Windows) or "Valve Steam Gamepad" (Steam Deck overlay; also Big Picture).
 *                  Talks to the game's local bridge server (SSE + POST) on 127.0.0.1.
 *                  The Steam overlay is Chromium too, so it must be checked before the others.
 *   webview2       window.chrome.webview exists: forwards to it as-is.
 *   none           Anything else: no connection is attempted, postMessage() resolves false.
 *   (cef is added later behind the same API.)
 *
 * No dependencies. ES5 syntax only, so it loads without errors in any browser. Browser APIs
 * beyond ES5 (fetch, EventSource) are used only inside the Steam overlay path, which is
 * Chromium; elsewhere the bridge reports 'none'.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') {
    return;  // not a browser (e.g. evaluated during SSR)
  }
  if (window.OverlayBridge && window.OverlayBridge.__isOverlayBridge) {
    return;  // already loaded by another <script> tag
  }

  var VERSION = '0.7.4';

  // <script src=".../overlay-bridge.js" data-auto-close="false">: keep a game-opened page whose
  // connection fails open (default: it closes itself, see steamOverlay). Read now: currentScript
  // is only set while this script runs.
  var AUTO_CLOSE = (function () {
    try {
      var script = document.currentScript;
      var value = script ? script.getAttribute('data-auto-close') : null;
      return value === null || String(value).toLowerCase() !== 'false';
    } catch (e) {
      return true;
    }
  })();

  //---------------------------------------------------------------------------
  // Launch token (must match native_bridge/ovb_token.c)
  //
  // The game appends  #ovbk=<token>  (or  &ovbk=<token>  after the page's own fragment).
  // token = base64url( version 0x01, port uint16 big-endian, key[32] ), 47 chars, not encrypted:
  // a decryption key would have to live in this public file, so it would add nothing.
  //---------------------------------------------------------------------------
  var FRAGMENT_PARAM = 'ovbk';
  var TOKEN_VERSION = 0x01;
  var B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  // -> array of byte values, or null when text is not unpadded base64url
  function base64UrlDecode(text) {
    if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
      return null;
    }
    var out = [];
    var bits = 0, value = 0;
    for (var i = 0; i < text.length; i++) {
      value = ((value << 6) | B64URL.indexOf(text.charAt(i))) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((value >>> bits) & 0xff);
      }
    }
    return out;
  }

  function base64UrlEncode(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var v = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      s += B64URL.charAt((v >>> 18) & 63) + B64URL.charAt((v >>> 12) & 63);
      if (i + 1 < bytes.length) { s += B64URL.charAt((v >>> 6) & 63); }
      if (i + 2 < bytes.length) { s += B64URL.charAt(v & 63); }
    }
    return s;
  }

  // -> { port: number, key: base64url string } or null when the token is not ours / damaged
  function decodeToken(token) {
    var raw = typeof token === 'string' ? base64UrlDecode(token) : null;
    if (!raw || raw.length !== 35 || raw[0] !== TOKEN_VERSION) {
      return null;
    }
    var port = (raw[1] << 8) | raw[2];
    if (port === 0) {
      return null;
    }
    return { port: port, key: base64UrlEncode(raw.slice(3)) };
  }

  // Splits '#...' into our token and the page's own fragment, left byte-for-byte as it was.
  // -> { token: string|null, rest: string (without '#') }
  function splitFragment(hash) {
    var token = null;
    var kept = String(hash || '').replace(/^#/, '').split('&').filter(function (part) {
      if (part.indexOf(FRAGMENT_PARAM + '=') === 0) {
        token = part.slice(FRAGMENT_PARAM.length + 1);
        return false;
      }
      return true;
    });
    return { token: token, rest: kept.join('&') };
  }

  if (window.__OVERLAY_BRIDGE_TEST_HOOKS__) {
    window.__OVERLAY_BRIDGE_TEST_HOOKS__.decodeToken = decodeToken;
    window.__OVERLAY_BRIDGE_TEST_HOOKS__.splitFragment = splitFragment;
  }

  //---------------------------------------------------------------------------
  // Listeners
  //---------------------------------------------------------------------------
  var listeners = { message: [], close: [], connected: [] };

  function dispatch(type, event) {
    (listeners[type] || []).slice().forEach(function (fn) {
      try {
        fn(event);
      } catch (e) {
        // a failing page listener must not break the bridge
        setTimeout(function () { throw e; });
      }
    });
  }

  // Promise.resolve(value), or a minimal thenable where Promise does not exist (legacy browsers)
  function resolved(value) {
    if (typeof Promise === 'function') {
      return Promise.resolve(value);
    }
    var thenable = {
      then: function (onResolved) {
        if (typeof onResolved === 'function') { onResolved(value); }
        return thenable;
      }
    };
    return thenable;
  }

  function fireReady(environment) {
    var event;
    try {
      event = new CustomEvent('overlaybridge:ready', { detail: { environment: environment } });
    } catch (e) {
      // no CustomEvent constructor (legacy browsers)
      if (typeof document === 'undefined' || !document.createEvent) { return; }
      event = document.createEvent('CustomEvent');
      event.initCustomEvent('overlaybridge:ready', false, false, { environment: environment });
    }
    window.dispatchEvent(event);
  }

  function isJsonValue(message) {
    try {
      return JSON.stringify(message) !== undefined;
    } catch (e) {
      return false;  // e.g. circular data
    }
  }

  //---------------------------------------------------------------------------
  // Steam overlay: local bridge server opened by the game for this popup.
  // Only a page that got the launch token connects; a session is never stored, so windows
  // opened from this page (which inherit a copy of sessionStorage) cannot take it over.
  // Popups do not navigate in place: new windows are opened through the game (openPopup),
  // so the game can track and close them too.
  //---------------------------------------------------------------------------
  var steamOverlay = {
    name: 'steam-overlay',

    detect: function () {
      var ua = navigator.userAgent;
      return (ua.indexOf('Valve Steam GameOverlay') !== -1 || ua.indexOf('Valve Steam Gamepad') !== -1) &&
        typeof EventSource !== 'undefined' && typeof fetch === 'function';
    },

    start: function () {
      var connected = false;
      var base = null;
      var sid = null;
      var popupId = null;
      var canOpen = false;          // the game says whether child popups can be shown (not on the Steam Deck)
      var dead = false;             // the game's bridge is gone for good: stop retrying, report nothing
      var ready = null;             // Promise resolved once a session id is available
      var nativeClosing = false;    // the game asked this page to close: nothing more to report
      var explicitClosing = false;  // an explicit close notice is out and the window is closing
      var nativeClose = window.close;
      var nativeOpen = window.open;

      // Read and strip the token before routers or analytics see the address
      var split = splitFragment(location.hash);
      if (split.token !== null) {
        // Absolute URL: a relative one would resolve against a <base href> on another origin and throw
        try {
          history.replaceState(history.state, '', location.href.split('#')[0] + (split.rest ? '#' + split.rest : ''));
        } catch (e) {}
      }
      var launch = split.token !== null ? decodeToken(split.token) : null;

      // POST to the game's bridge server. Close notices go as text/plain (a CORS "simple" request,
      // like sendBeacon's) with keepalive, so they survive the page going away.
      function post(path, body, closeNotice) {
        return fetch(base + path, {
          method: 'POST',
          headers: { 'Content-Type': closeNotice ? 'text/plain' : 'application/json' },
          body: JSON.stringify(body),
          keepalive: !!closeNotice
        });
      }

      // Connect with the one-time key, retried briefly. The game's refusals (403) carry no CORS
      // headers, so the page sees them as network failures too; only a readable error status
      // ends the tries at once.
      var CONNECT_ATTEMPTS = 3;
      var CONNECT_RETRY_MS = 300;
      function connect(attempt) {
        return post('/connect', { key: launch.key }).then(function (r) {
          if (!r.ok) {
            var refused = new Error('overlay-bridge: connect rejected (' + r.status + ')');
            refused.final = true;
            throw refused;
          }
          return r.json();
        }).then(null, function (e) {
          if ((e && e.final) || attempt + 1 >= CONNECT_ATTEMPTS) {
            throw e;
          }
          return new Promise(function (resolve) { setTimeout(resolve, CONNECT_RETRY_MS); }).then(function () {
            return connect(attempt + 1);
          });
        });
      }

      if (launch) {
        base = 'http://127.0.0.1:' + launch.port;
        ready = connect(0).then(function (j) {
          if (!j || typeof j.sid !== 'string' || !j.sid) { throw new Error('overlay-bridge: bad connect reply'); }
          sid = j.sid;
          popupId = typeof j.popupId === 'number' ? j.popupId : null;
          canOpen = j.canOpenPopup === true;
        });
        // The game opens its server before it shows the page, so a page whose token leads nowhere
        // (no server, or the key refused) is not one the game is waiting for: e.g. Steam showing a
        // request from an earlier run (one made while the overlay was off). It closes itself
        // unless the page opted out (data-auto-close="false").
        ready.then(null, function () {
          if (AUTO_CLOSE) {
            nativeClose.call(window);
          }
        });
      }

      // The page is (probably) going away without an explicit close: pagehide (overlay X button on
      // desktop Steam), beforeunload, or hidden. On the Steam Deck the B / Steam buttons tear the
      // page down and beforeunload / pagehide often do not get out in time; hidden always arrives
      // first (0.2-3 s before). The game only counts a notice if the stream drops soon after it,
      // so a page that is just hidden (desktop Shift+Tab) and stays alive is not affected.
      // Sent once per event (hidden again after each visible), and not while an explicit close is
      // on its way (the game keeps the last notice). sendBeacon survives page unload; keepalive
      // fetch is the fallback. text/plain keeps it a CORS "simple" request. The game reports
      // USER_CLOSED when this arrives before the drop.
      var noticeSent = {};
      function sendClosing(reason) {
        if (nativeClosing || explicitClosing || dead || noticeSent[reason] || !base || !sid) {
          return;
        }
        noticeSent[reason] = true;
        var notice = { sid: sid, popupId: popupId, reason: reason, explicit: false };
        try {
          if (navigator.sendBeacon && navigator.sendBeacon(base + '/closing', JSON.stringify(notice))) {
            return;
          }
        } catch (e) {}
        try {
          post('/closing', notice, true).then(null, function () {});
        } catch (e2) {}
      }

      // Explicit close: the page is still alive, so send the notice as a normal request and close
      // once the game has it (or after CLOSE_ACK_TIMEOUT_MS). A beacon sent right before
      // window.close() can be dropped when the Steam overlay tears the page down at once.
      // Further close calls while one is on its way do nothing (double click, closePopup then
      // window.close). If the page is still here CLOSE_REFUSED_MS later, the close did not happen
      // and later notices count again.
      var CLOSE_ACK_TIMEOUT_MS = 300;
      var CLOSE_REFUSED_MS = 1000;
      function closeAfterNotice(reason) {
        if (explicitClosing) {
          return;
        }
        if (nativeClosing || dead || !base || !sid) {
          nativeClose.call(window);
          return;
        }
        explicitClosing = true;
        var done = false;
        function finish() {
          if (done) {
            return;
          }
          done = true;
          nativeClose.call(window);
          setTimeout(function () {
            explicitClosing = false;
            noticeSent = {};
          }, CLOSE_REFUSED_MS);
        }
        setTimeout(finish, CLOSE_ACK_TIMEOUT_MS);
        try {
          post('/closing', { sid: sid, popupId: popupId, reason: reason, explicit: true }, true).then(finish, finish);
        } catch (e) {
          finish();
        }
      }

      function absoluteHttpUrl(url) {
        var a = document.createElement('a');
        a.href = String(url);
        return /^https?:$/.test(a.protocol) ? a.href : null;
      }

      // Asks the game to open url as a new tracked popup. -> Promise<popupId or null>
      // Waits for the connection first. The game may refuse (e.g. a site outside its allow list);
      // where it cannot show another popup (Steam Deck), or the bridge is gone, nothing is asked.
      function openViaGame(url) {
        if (!ready) {
          return Promise.resolve(null);
        }
        return ready.then(function () {
          if (!canOpen || dead) {
            throw new Error('overlay-bridge: popups cannot be opened here');
          }
          return post('/open', { sid: sid, url: url });
        }).then(function (r) {
          return r.ok ? r.json() : null;
        }).then(function (j) {
          return j && typeof j.popupId === 'number' ? j.popupId : null;
        }, function () {
          return null;
        });
      }

      if (launch) {
        // Existing page code that calls window.close() reports PAGE_REQUEST without any change
        window.close = function () {
          closeAfterNotice('window.close');
        };

        // Existing window.open() calls (new window: no name or '_blank'), links and GET forms that
        // open a new window open tracked popups through the game instead of untracked overlay
        // windows; window.open() then returns null. Named targets ('_self', an iframe, a named
        // window) are left alone.
        window.open = function (url, name) {
          var target = url === undefined || url === '' ? null : absoluteHttpUrl(url);
          var newWindow = name === undefined || name === null || name === '' || String(name).toLowerCase() === '_blank';
          if (target === null || !newWindow) {
            return nativeOpen.apply(window, arguments);
          }
          openViaGame(target);
          return null;
        };

        // A link's or form's target: its own attribute, else the document's <base target>
        function targetOf(el, attr) {
          var t = el.getAttribute(attr);
          if (t === null) {
            var base = document.querySelector('base[target]');
            t = base ? base.getAttribute('target') : '';
          }
          return String(t || '').toLowerCase();
        }

        // Links: HTML <a> / <area>, and SVG <a> (href or xlink:href). A new window is target="_blank"
        // (also from <base target>), Ctrl / Shift / Cmd + click, or a middle click (auxclick).
        // Download links are left alone. Bubble phase on window: runs after the page's own handlers,
        // so a link the page already handled (preventDefault, e.g. an onclick that calls window.open
        // itself) is left alone.
        function onLinkClick(e) {
          var middle = e.type === 'auxclick';
          if (e.defaultPrevented || e.button !== (middle ? 1 : 0) || !e.target || !e.target.closest) {
            return;
          }
          var a = e.target.closest('a, area');
          if (!a || a.hasAttribute('download')) {
            return;
          }
          var href = a.getAttribute('href');
          if (href === null) {
            href = a.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
          }
          var newWindow = middle || targetOf(a, 'target') === '_blank' || e.ctrlKey || e.shiftKey || e.metaKey;
          var target = href !== null && newWindow ? absoluteHttpUrl(href) : null;
          if (target !== null) {
            e.preventDefault();
            openViaGame(target);
          }
        }
        window.addEventListener('click', onLinkClick, false);
        window.addEventListener('auxclick', onLinkClick, false);

        // Forms submitted to a new window (target / formtarget "_blank", or <base target>): a GET
        // form becomes a URL the game opens. A POST form cannot (the game opens URLs only), so it is
        // left to the overlay as an untracked window.
        window.addEventListener('submit', function (e) {
          var form = e.target;
          if (e.defaultPrevented || !form || String(form.nodeName).toLowerCase() !== 'form') {
            return;
          }
          var submitter = e.submitter || null;
          function attr(name, formName) {
            return submitter && submitter.hasAttribute(formName) ? submitter.getAttribute(formName) : form.getAttribute(name);
          }
          var newWindow = submitter && submitter.hasAttribute('formtarget')
            ? submitter.getAttribute('formtarget').toLowerCase() === '_blank'
            : targetOf(form, 'target') === '_blank';
          if (!newWindow || String(attr('method', 'formmethod') || 'get').toLowerCase() !== 'get') {
            return;
          }
          var action = absoluteHttpUrl(attr('action', 'formaction') || location.href);
          if (action === null) {
            return;
          }
          var data;
          try {
            data = new FormData(form, submitter || undefined);
          } catch (err) {
            data = new FormData(form);  // older Chromium: no submitter argument
          }
          // As the browser does for GET: the form data replaces the action URL's query
          var hashAt = action.indexOf('#');
          var hash = hashAt === -1 ? '' : action.slice(hashAt);
          var path = (hashAt === -1 ? action : action.slice(0, hashAt)).split('?')[0];
          e.preventDefault();
          openViaGame(path + '?' + new URLSearchParams(data).toString() + hash);
        }, false);

        // Registered now (overlay-bridge.js loads before the page's scripts) and in the capture phase,
        // so the close notice goes out before other handlers' requests: the desktop overlay X button
        // tears the page down so fast that only the first request gets out. Before the session
        // exists sendClosing() sends nothing.
        var source = null;
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') {
            sendClosing('hidden');
          } else {
            noticeSent.hidden = false;
          }
        }, true);
        window.addEventListener('beforeunload', function () {
          sendClosing('beforeunload');
        }, true);
        window.addEventListener('pagehide', function () {
          sendClosing('pagehide');
          if (source) {
            source.close();
          }
        }, true);

        // EventSource retries by itself (the game asks for a short retry so a momentary drop is
        // absorbed). After MAX_STREAM_ERRORS failures in a row the game's bridge is gone (closed,
        // or the game exited): stop, so the page does not retry forever and reports not connected.
        var MAX_STREAM_ERRORS = 10;
        var streamErrors = 0;
        ready.then(function () {
          try {
            source = new EventSource(base + '/events?sid=' + encodeURIComponent(sid));
          } catch (e) {
            dead = true;
            return;
          }
          source.onopen = function () {
            var was = connected;
            connected = true;
            streamErrors = 0;
            if (!was) {
              dispatch('connected', { type: 'connected' });
            }
          };
          source.onerror = function () {
            connected = false;
            if (++streamErrors >= MAX_STREAM_ERRORS) {
              dead = true;
              source.close();
            }
          };
          source.addEventListener('message', function (e) {
            var data;
            try { data = JSON.parse(e.data); } catch (err) { return; }
            dispatch('message', { type: 'message', data: data });
          });
          source.addEventListener('close', function () {
            nativeClosing = true;  // the game asked for this close; nothing to report
            source.close();
            connected = false;
            dispatch('close', { type: 'close' });  // listeners run now; the window closes right after
            nativeClose.call(window);
          });
        }).then(null, function () {
          ready = null;  // connect failed: postMessage() resolves false
        });
      }

      return {
        isConnected: function () { return connected; },
        getPopupId: function () { return popupId; },
        canOpenPopup: function () { return launch ? !!sid && canOpen && !dead : true; },
        closePopup: function (reason) {
          closeAfterNotice(typeof reason === 'string' && reason ? reason.slice(0, 64) : 'page');
        },
        openPopup: function (url) {
          if (!launch) {
            return noBridge.openPopup(url);  // not opened by the game: a plain new window
          }
          var target = absoluteHttpUrl(url);
          return target === null ? resolved(null) : openViaGame(target);
        },
        postMessage: function (message) {
          if (!ready || dead) {
            return Promise.resolve(false);
          }
          return ready.then(function () {
            return post('/message', { sid: sid, message: message });
          }).then(function (r) { return r.ok; }, function () { return false; });
        }
      };
    }
  };

  //---------------------------------------------------------------------------
  // No native side (any other browser, or before a transport is found): popups are plain
  // browser windows and messages go nowhere.
  //---------------------------------------------------------------------------
  var noBridge = {
    isConnected: function () { return false; },
    getPopupId: function () { return null; },
    canOpenPopup: function () { return true; },  // a plain window.open
    closePopup: function () { window.close(); },
    openPopup: function (url) {
      window.open(url, '_blank');
      return resolved(null);
    },
    postMessage: function () { return resolved(false); }
  };

  //---------------------------------------------------------------------------
  // WebView2 (PC launcher): pass everything through to window.chrome.webview unchanged.
  // The launcher closes its own window, so no 'close' event is raised here.
  //---------------------------------------------------------------------------
  var webView2 = {
    name: 'webview2',

    detect: function () {
      return !!(window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function');
    },

    start: function () {
      var webview = window.chrome.webview;
      webview.addEventListener('message', function (e) {
        dispatch('message', e);  // the original WebView2 event (e.data, e.source, ...)
      });
      return {
        isConnected: function () { return true; },
        getPopupId: noBridge.getPopupId,  // Steam only for now
        canOpenPopup: noBridge.canOpenPopup,
        closePopup: noBridge.closePopup,
        openPopup: noBridge.openPopup,
        postMessage: function (message) {
          try {
            webview.postMessage(message);
            return resolved(true);
          } catch (e) {
            return resolved(false);
          }
        }
      };
    }
  };

  var TRANSPORTS = [steamOverlay, webView2];  // cef goes here later

  var activeName = 'none';
  var active = noBridge;
  for (var i = 0; i < TRANSPORTS.length; i++) {
    if (TRANSPORTS[i].detect()) {
      activeName = TRANSPORTS[i].name;
      active = TRANSPORTS[i].start();
      break;
    }
  }

  window.OverlayBridge = Object.freeze({
    __isOverlayBridge: true,
    version: VERSION,
    getEnvironment: function () { return activeName; },
    isAvailable: function () { return active.isConnected(); },
    getPopupId: function () { return active.getPopupId(); },
    canOpenPopup: function () { return active.canOpenPopup(); },
    closePopup: function (reason) { active.closePopup(reason); },
    openPopup: function (url) { return active.openPopup(url); },
    postMessage: function (message) {
      return isJsonValue(message) ? active.postMessage(message) : resolved(false);
    },
    addEventListener: function (type, fn) {
      if (listeners[type] && typeof fn === 'function' && listeners[type].indexOf(fn) === -1) {
        listeners[type].push(fn);
        if (type === 'connected' && active.isConnected()) {
          // Already connected: a listener added late still hears it once (asynchronously, like an event)
          setTimeout(function () {
            if (listeners.connected.indexOf(fn) !== -1) {
              try { fn({ type: 'connected' }); } catch (e) { setTimeout(function () { throw e; }); }
            }
          }, 0);
        }
      }
    },
    removeEventListener: function (type, fn) {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter(function (f) { return f !== fn; });
      }
    }
  });

  fireReady(activeName);
})();
