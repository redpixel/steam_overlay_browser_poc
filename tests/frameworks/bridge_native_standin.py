# Stand-in for the native SDK native side of the popup bridge (PoC, test only): a Python
# implementation of the same rules as the bridge DLL (native_bridge/ovb_bridge.cpp).
# Usage: python bridge_native_standin.py [extra allowed origin ...]
#
# One bridge server per popup, on 127.0.0.1:<ephemeral port>, alive only while the popup is
# (a popup closed while its page was still loading keeps it LINGER_S more, to tell the page to close).
#   POST /connect  {"key"}                            one-time key from the URL fragment -> {"sid","popupId","canOpenPopup"}
#   GET  /events?sid=                                 SSE: "message" <JSON as-is> and "close" (native -> web)
#   POST /message  {"sid","message"}                  web -> native, message passed through as-is
#   POST /closing  {"sid","popupId","reason","explicit"}  page is going away (text/plain)
#   POST /open     {"sid","url"}                     page asks for a new tracked popup -> {"popupId"}
# Every request: Host must be 127.0.0.1:<port>, Origin must be allow-listed.
#
# Close reasons (one per popup, final):
#   NATIVE_REQUEST   game called close
#   PAGE_REQUEST     the page closed itself (window.close / OverlayBridge.closePopup) and the
#                    stream dropped within EXPLICIT_WINDOW_S of that notice
#   USER_CLOSED      the page sent a non-explicit notice (hidden / beforeunload / pagehide) within
#                    EXPLICIT_WINDOW_S before the stream dropped (overlay X, Steam Deck B / Steam button)
#   CONNECTION_LOST  stream dropped and did not come back within GRACE_S, no notice at all (crash...)
#   NEVER_CONNECTED  the page never connected within the connect timeout
#   SHUTDOWN         game shut the bridge down
# Popups opened from a popup (POST /open) are children: when a parent closes, its open children
# are closed by the game (NATIVE_REQUEST).
#
# Tester control on 127.0.0.1:27081: bridge_control.py (shared with bridge_dll_host.py).
# can_open_popup defaults to yes on Windows and no elsewhere (the Steam Deck overlay shows one page
# at a time; the DLL asks SteamUtils()->IsSteamRunningOnSteamDeck()).
import http.server, threading, queue, time, json, secrets, select, hmac, urllib.parse, ctypes, base64, os
from bridge_control import ALLOWED_ORIGINS, log, make_server

# Popup URLs are built by the real C library (native_bridge/ovb_token.dll) on Windows.
# Elsewhere (Steam Deck test runs, the C library is Windows only for now) the same token format
# is built here: base64url(0x01 | port BE16 | key[32]) as #ovbk= (or &ovbk= after a page hash).
if os.name == 'nt':
    OVB = ctypes.CDLL(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'native_bridge', 'out', 'ovb_token.dll'))
    OVB.ovb_build_popup_url.argtypes = [ctypes.c_char_p, ctypes.c_uint16, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_size_t]
    OVB.ovb_build_popup_url.restype = ctypes.c_int
else:
    OVB = None


def build_popup_url(base_url, port, key_bytes):
    if OVB is None:
        token = base64.urlsafe_b64encode(bytes([0x01, port >> 8, port & 0xFF]) + key_bytes).rstrip(b'=').decode()
        return base_url + ('&' if '#' in base_url else '#') + 'ovbk=' + token
    out = ctypes.create_string_buffer(len(base_url) + 128)
    rc = OVB.ovb_build_popup_url(base_url.encode(), port, key_bytes, out, len(out))
    assert rc == 0, f'ovb_build_popup_url failed: {rc}'
    return out.value.decode()

GRACE_S = 1.0              # a dropped stream may come back within this: EventSource retries after
SSE_RETRY_MS = 200         # SSE_RETRY_MS ('retry:' line), which must stay well below GRACE_S
EXPLICIT_WINDOW_S = 5.0    # an explicit close notice only counts if the stream drops this soon after it
CONNECT_TIMEOUT_S = 300.0
MAX_BODY = 16 * 1024
LINGER_S = 60.0            # a popup closed while its page was loading keeps serving this long (see request_close)
CAN_OPEN_POPUP_DEFAULT = os.name == 'nt'   # the real game asks SteamUtils()->IsSteamRunningOnSteamDeck()


def url_origin(url):
    """The origin of an http(s) URL as a browser sends it (lower case, no default port), or None."""
    try:
        p = urllib.parse.urlsplit(url.replace('\\', '/'))
        port = p.port
    except ValueError:
        return None
    if p.scheme not in ('http', 'https') or not p.hostname or '@' in p.netloc:
        return None
    if port in (None, {'http': 80, 'https': 443}[p.scheme]):
        return f'{p.scheme}://{p.hostname}'
    return f'{p.scheme}://{p.hostname}:{port}'

sessions = {}
lock = threading.Lock()
next_id = [1]

class Session:
    def __init__(self, base_url, connect_timeout, parent=None, can_open_popup=CAN_OPEN_POPUP_DEFAULT):
        with lock:
            self.id = next_id[0]; next_id[0] += 1
        self.key_bytes = secrets.token_bytes(32)
        self.key = base64.urlsafe_b64encode(self.key_bytes).rstrip(b'=').decode()
        self.web_messages = []
        self.key_used = False
        self.sid = None
        self.streams = set()          # queues of live SSE connections
        self.created = time.time()
        self.connect_timeout = connect_timeout
        self.disconnected_at = None
        self.state = 'waiting'        # waiting -> open -> closed
        self.close_requested = False
        self.shutting_down = False
        self.page_notice = None       # last /closing body + time
        self.close_reason = None
        self.parent = parent           # popup id that asked for this one (POST /open)
        self.can_open_popup = can_open_popup
        self.launched = parent is None  # children wait for the game to open them
        self.linger_until = None        # closed while loading: still serving until then (request_close)
        self.linger_stream_seen = False
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), BridgeHandler)
        self.server.session = self
        self.port = self.server.server_address[1]
        self.url = build_popup_url(base_url, self.port, self.key_bytes)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        log(f'[{self.id}] bridge listening on 127.0.0.1:{self.port}')

    def push(self, event, payload):
        for q in list(self.streams):
            q.put((event, payload))
        return len(self.streams)

    def resolve_reason(self):
        if self.shutting_down:
            return 'SHUTDOWN'
        if self.close_requested:
            return 'NATIVE_REQUEST'
        n = self.page_notice
        if n and self.disconnected_at and self.disconnected_at - n['at'] <= EXPLICIT_WINDOW_S:
            return 'PAGE_REQUEST' if n['explicit'] else 'USER_CLOSED'
        return 'CONNECTION_LOST'

    def stop_server(self):
        def stop():
            self.server.shutdown()
            self.server.server_close()   # release the port: a late page gets refused, as with the DLL
        threading.Thread(target=stop, daemon=True).start()

    def mark_closed(self, reason, linger=False):
        if self.state == 'closed':
            return
        self.state = 'closed'
        self.close_reason = reason
        detail = f" (page reason: {self.page_notice['reason']!r})" if self.page_notice else ''
        if linger:
            self.linger_until = time.time() + LINGER_S
            log(f'[{self.id}] *** onClosed(popupId={self.id}, {reason}){detail} -> server lingers for a late page')
        else:
            log(f'[{self.id}] *** onClosed(popupId={self.id}, {reason}){detail} -> bridge server stopped')
            self.stop_server()
        with lock:
            children = [c for c in sessions.values() if c.parent == self.id and c.state != 'closed']
        for c in children:
            log(f'[{c.id}] parent {self.id} closed -> closing child')
            c.close_requested = True
            c.request_close('NATIVE_REQUEST')

    def request_close(self, if_waiting):
        """Closes a popup whose page has not connected yet at once; otherwise asks the page to close.
        A page still loading would stay on screen, so its server lingers (LINGER_S) and tells the
        page to close once it connects. Not while shutting down."""
        if self.state != 'waiting':
            return self.push('close', None)
        self.mark_closed(if_waiting, linger=not self.shutting_down)
        return 0


class BridgeHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    @property
    def s(self):
        return self.server.session

    def deny(self, why):
        log(f'[{self.s.id}] DENY {self.command} {self.path.split("?")[0]}: {why}')
        self.send_response(403)
        self.send_header('Content-Length', '0')
        self.send_header('Connection', 'close')
        self.end_headers()

    def checked_origin(self):
        """Returns the allowed Origin, or None after sending 403."""
        if self.headers.get('Host') != f'127.0.0.1:{self.s.port}':
            self.deny(f'bad Host {self.headers.get("Host")!r}')     # DNS rebinding guard
            return None
        origin = self.headers.get('Origin')
        if origin not in ALLOWED_ORIGINS:
            self.deny(f'origin {origin!r} not allowed')
            return None
        return origin

    def cors(self, origin):
        self.send_header('Access-Control-Allow-Origin', origin)
        self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def json_reply(self, origin, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.cors(origin)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        # Body is JSON whatever the Content-Type (sendBeacon sends text/plain)
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BODY:
            return None
        try:
            obj = json.loads(self.rfile.read(n))
            return obj if isinstance(obj, dict) else None
        except ValueError:
            return None

    def sid_ok(self, sid):
        return bool(self.s.sid) and isinstance(sid, str) and hmac.compare_digest(sid, self.s.sid)

    def do_OPTIONS(self):
        origin = self.checked_origin()
        if not origin:
            return
        self.send_response(204)
        self.cors(origin)
        self.send_header('Access-Control-Allow-Methods', 'POST, GET')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        origin = self.checked_origin()
        if not origin:
            return
        path = self.path.split('?')[0]
        body = self.read_json()
        if body is None:
            return self.deny('body is not a JSON object (or too large)')
        if self.s.state == 'closed' and path != '/connect':
            return self.deny('closed while loading: only connect and close')

        if path == '/connect':
            key = body.get('key')
            if self.s.key_used or not isinstance(key, str) or not hmac.compare_digest(key, self.s.key):
                return self.deny('bad or already used key')
            self.s.key_used = True
            self.s.sid = secrets.token_urlsafe(32)
            log(f'[{self.s.id}] key accepted (now invalid), session issued, origin={origin}')
            return self.json_reply(origin, {'sid': self.s.sid, 'popupId': self.s.id, 'canOpenPopup': self.s.can_open_popup})

        if path == '/message':
            if not self.sid_ok(body.get('sid')):
                return self.deny('bad sid')
            if 'message' not in body:
                return self.deny('missing message')
            self.s.web_messages.append(body['message'])
            log(f'[{self.s.id}] WEB -> NATIVE  {json.dumps(body["message"], ensure_ascii=False)}')
            return self.json_reply(origin, {'ok': True})

        if path == '/closing':
            if not self.sid_ok(body.get('sid')):
                return self.deny('bad sid')
            if body.get('popupId') != self.s.id:
                return self.deny(f'popupId {body.get("popupId")!r} does not match this popup ({self.s.id})')
            reason = body.get('reason')
            if not isinstance(reason, str) or not 0 < len(reason) <= 64:
                return self.deny('missing/invalid reason')
            self.s.page_notice = {'reason': reason, 'explicit': body.get('explicit') is True, 'at': time.time()}
            log(f'[{self.s.id}] page closing notice: popupId={self.s.id} reason={reason!r} explicit={body.get("explicit") is True}')
            return self.json_reply(origin, {'ok': True})

        if path == '/open':
            if not self.sid_ok(body.get('sid')):
                return self.deny('bad sid')
            if not self.s.can_open_popup:
                return self.deny('open refused: this popup cannot open popups (one page at a time)')
            url = body.get('url')
            if not isinstance(url, str) or len(url) > 2048 or url_origin(url) not in ALLOWED_ORIGINS:
                return self.deny(f'open refused for {url!r} (not an allowed site)')
            child = Session(url, self.s.connect_timeout, parent=self.s.id, can_open_popup=self.s.can_open_popup)
            with lock:
                sessions[child.id] = child
            log(f'[{child.id}] *** onOpened(popupId={child.id}, parent={self.s.id}, {url})')
            return self.json_reply(origin, {'popupId': child.id})

        self.deny('unknown path')

    def do_GET(self):
        origin = self.checked_origin()
        if not origin:
            return
        parsed = urllib.parse.urlparse(self.path)
        sid = urllib.parse.parse_qs(parsed.query).get('sid', [None])[0]
        if parsed.path != '/events' or not self.sid_ok(sid):
            return self.deny('bad path or sid')

        q = queue.Queue()
        s = self.s
        reconnect = s.state == 'open'
        s.streams.add(q)
        s.disconnected_at = None
        if s.state == 'waiting':
            s.state = 'open'
            log(f'[{s.id}] *** POPUP OPEN (stream connected {time.time() - s.created:.1f}s after create) ua={self.headers.get("User-Agent")}')
        elif s.state == 'closed':
            s.linger_stream_seen = True   # closed while loading: told to close below
            log(f'[{s.id}] late page connected after close -> telling it to close')
        elif reconnect:
            s.page_notice = None   # the page is still there (EventSource retry): its notice was not a close
            log(f'[{s.id}] stream reconnected')

        self.send_response(200)
        self.cors(origin)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(f'retry: {SSE_RETRY_MS}\n\n'.encode()); self.wfile.flush()
            if s.close_requested or s.shutting_down:
                q.put(('close', None))
            last_write = time.time()
            while True:
                # Peer closed? (readable with EOF)
                r, _, _ = select.select([self.connection], [], [], 0)
                if r and not self.connection.recv(1, 2):   # MSG_PEEK
                    break
                try:
                    event, payload = q.get(timeout=0.25)
                    data = json.dumps(payload, ensure_ascii=False)
                    self.wfile.write(f'event: {event}\ndata: {data}\n\n'.encode()); self.wfile.flush()
                    log(f'[{s.id}] NATIVE -> WEB  {event} {data}')
                    last_write = time.time()
                except queue.Empty:
                    if time.time() - last_write > 15:
                        self.wfile.write(b': keep-alive\n\n'); self.wfile.flush()
                        last_write = time.time()
        except (ConnectionError, OSError):
            pass
        finally:
            s.streams.discard(q)
            if not s.streams and s.state == 'open':
                s.disconnected_at = time.time()
                log(f'[{s.id}] stream dropped, waiting {GRACE_S}s for reconnect')


def supervisor():
    while True:
        time.sleep(0.25)
        now = time.time()
        with lock:
            items = list(sessions.values())
        for s in items:
            if s.state == 'open' and not s.streams and s.disconnected_at and now - s.disconnected_at >= GRACE_S:
                s.mark_closed(s.resolve_reason())
            elif s.state == 'waiting' and now - s.created >= s.connect_timeout:
                s.mark_closed('NEVER_CONNECTED')
            elif s.linger_until and (now >= s.linger_until or (s.linger_stream_seen and not s.streams)):
                s.linger_until = None
                log(f'[{s.id}] linger over -> bridge server stopped')
                s.stop_server()


class StandinBackend:
    """The control API (bridge_control.py) on top of the Python sessions."""

    def new(self, base, timeout, can_open):
        s = Session(base, CONNECT_TIMEOUT_S if timeout is None else timeout,
                    can_open_popup=CAN_OPEN_POPUP_DEFAULT if can_open is None else can_open)
        with lock:
            sessions[s.id] = s
        return s.id, s.url

    def known(self, pid):
        with lock:
            return pid in sessions

    def latest(self):
        with lock:
            return max(sessions) if sessions else None

    def launched(self, pid):
        s = sessions[pid]
        s.launched = True
        s.created = time.time()   # connect timeout counts from the real open
        return True

    def shutdown(self):
        with lock:
            items = list(sessions.values())
        for s in items:
            if s.state == 'closed':
                continue
            s.shutting_down = True
            s.request_close('SHUTDOWN')   # pages close themselves; supervisor reports SHUTDOWN

    def send(self, pid, raw):
        return sessions[pid].push('message', json.loads(raw))

    def close(self, pid):
        s = sessions[pid]
        s.close_requested = True
        return s.request_close('NATIVE_REQUEST')

    def pending(self):
        with lock:
            return [{'id': s.id, 'url': s.url, 'parent': s.parent} for s in sessions.values()
                    if not s.launched and s.state == 'waiting']

    def status(self):
        with lock:
            return {sid: {'state': s.state, 'port': s.port, 'streams': len(s.streams), 'key_used': s.key_used,
                          'web_messages': s.web_messages, 'close_reason': s.close_reason,
                          'page_notice': s.page_notice, 'parent': s.parent, 'launched': s.launched,
                          'can_open_popup': s.can_open_popup}
                    for sid, s in sessions.items()}


threading.Thread(target=supervisor, daemon=True).start()
make_server(StandinBackend()).serve_forever()
