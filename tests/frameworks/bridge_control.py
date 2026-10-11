# Control API of the native side for the tests (test only), shared by its two hosts:
#   bridge_native_standin.py  Python implementation of the bridge rules
#   bridge_dll_host.py        the real DLL (native_bridge/out/overlay_bridge.dll) through ctypes
# The framework tests talk to it on 127.0.0.1:27081 and do not depend on which host answers.
#
#   POST /new?base=URL[&connect_timeout=S][&can_open_popup=0|1]   open a popup -> {id, url}
#   POST /send?id=N      body = any JSON, native -> web as is        -> {delivered_to_streams}
#   POST /close?id=N     native close                                -> {delivered_to_streams}
#   POST /shutdown       close every popup (SHUTDOWN)                -> {ok}
#   GET  /pending        child popups the game still has to show     -> [{id, url, parent}]
#   POST /launched?id=N  the test showed child N in a browser        -> {ok}
#   GET  /status         {id: {state, close_reason, page_notice, parent, key_used, streams,
#                               can_open_popup, web_messages, launched}}
# Without id: the newest popup. Unknown id: 404. An id that is not a number: 400.
import datetime, http.server, json, sys, urllib.parse

CONTROL_PORT = 27081
DEFAULT_BASE = 'http://127.0.0.1:8766/popup_test.html'
ALLOWED_ORIGINS = ['http://127.0.0.1:8766', 'https://store.example.com'] + sys.argv[1:]

# Logs carry page messages (any Unicode): a console code page such as cp949 must not make a
# print fail, which would abort the request being handled
sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def log(msg):
    print(f'[{datetime.datetime.now():%H:%M:%S.%f}'[:-3] + f'] {msg}', flush=True)


def make_server(backend):
    """backend: new(base, timeout_s or None, can_open or None) -> (id, url); known(id); latest();
    launched(id) -> bool; shutdown(); send(id, raw_json_bytes) -> int; close(id) -> int;
    pending() -> list; status() -> dict"""

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False, indent=1).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def target(self, qs):
            """-> (popup id, None) or (None, error reply args)"""
            if 'id' not in qs:
                pid = backend.latest()
                return (pid, None) if pid is not None else (None, ({'error': 'no popup'}, 404))
            try:
                pid = int(qs['id'][0])
            except ValueError:
                return None, ({'error': 'bad id'}, 400)
            return (pid, None) if backend.known(pid) else (None, ({'error': f'no popup {pid}'}, 404))

        def do_POST(self):
            self.guarded(self.post)

        def do_GET(self):
            self.guarded(self.get)

        def guarded(self, handler):
            try:
                handler()
            except Exception as e:   # a host failure becomes a 500 with the reason, not a dropped connection
                log(f'control {self.command} {self.path} failed: {e!r}')
                self.reply({'error': repr(e)}, 500)

        def post(self):
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            if parsed.path == '/new':
                timeout = float(qs['connect_timeout'][0]) if 'connect_timeout' in qs else None
                can_open = qs['can_open_popup'][0] != '0' if 'can_open_popup' in qs else None
                pid, url = backend.new(qs.get('base', [DEFAULT_BASE])[0], timeout, can_open)
                return self.reply({'id': pid, 'url': url})
            if parsed.path == '/shutdown':
                log('shutdown requested')
                backend.shutdown()
                return self.reply({'ok': True})
            pid, error = self.target(qs)
            if error:
                return self.reply(*error)
            if parsed.path == '/launched':
                return self.reply({'ok': backend.launched(pid)})
            if parsed.path == '/send':
                raw = self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'null'
                return self.reply({'delivered_to_streams': backend.send(pid, raw)})
            if parsed.path == '/close':
                log(f'[{pid}] native close requested')
                return self.reply({'delivered_to_streams': backend.close(pid)})
            self.reply({'error': 'unknown path'}, 404)

        def get(self):
            path = urllib.parse.urlparse(self.path).path
            if path == '/pending':
                return self.reply(backend.pending())
            if path == '/status':
                return self.reply(backend.status())
            self.reply({'error': 'unknown path'}, 404)

    http.server.ThreadingHTTPServer.request_queue_size = 64
    log(f'control on 127.0.0.1:{CONTROL_PORT}; allowed origins: {ALLOWED_ORIGINS}')
    return http.server.ThreadingHTTPServer(('127.0.0.1', CONTROL_PORT), Handler)
