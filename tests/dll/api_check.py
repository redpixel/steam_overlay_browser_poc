# Checks the bridge DLL's C API directly (no browser), test only: argument and state errors, allowed
# origin checks, JSON validation of OVB_PostMessage, the waiting-message limit, close notices after a
# reconnect, limits, overlay failure, shutdown and re-init. Pages are played with raw HTTP.
# Run: python tests/dll/api_check.py   (exit code 0 = all passed; needs native_bridge/out/overlay_bridge.dll)
import base64, ctypes, http.client, json, os, re, socket, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
DLL = ctypes.CDLL(os.path.join(HERE, '..', '..', 'native_bridge', 'out', 'overlay_bridge.dll'))

OK, ERR_ARGS, ERR_STATE, ERR_NETWORK, ERR_OVERLAY, ERR_NOT_FOUND, ERR_CLOSED, ERR_JSON, ERR_RANDOM, ERR_LIMIT = 0, -1, -2, -3, -4, -5, -6, -7, -8, -9
WAITING, OPEN, CLOSED = 1, 2, 3
NATIVE_REQUEST, SHUTDOWN = 1, 5

OnMessage = ctypes.CFUNCTYPE(None, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_void_p)
OnClosed = ctypes.CFUNCTYPE(None, ctypes.c_uint32, ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p)
OnOpened = ctypes.CFUNCTYPE(None, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_void_p)
OpenOverlay = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_void_p)


class Config(ctypes.Structure):
    _fields_ = [('structSize', ctypes.c_uint32), ('allowedOrigins', ctypes.POINTER(ctypes.c_char_p)),
                ('allowedOriginCount', ctypes.c_uint32), ('onMessage', OnMessage), ('onClosed', OnClosed),
                ('onOpened', OnOpened), ('openOverlay', OpenOverlay), ('user', ctypes.c_void_p)]


class PopupInfo(ctypes.Structure):
    _fields_ = [('structSize', ctypes.c_uint32), ('state', ctypes.c_uint32), ('closeReason', ctypes.c_uint32),
                ('parentPopupId', ctypes.c_uint32), ('keyUsed', ctypes.c_uint32), ('streams', ctypes.c_uint32),
                ('canOpenPopup', ctypes.c_uint32), ('hasNotice', ctypes.c_uint32), ('noticeExplicit', ctypes.c_uint32),
                ('noticeTimeMs', ctypes.c_uint64), ('noticeReason', ctypes.c_char * 260)]


DLL.OVB_Init.argtypes = [ctypes.POINTER(Config)]
DLL.OVB_Update.restype = None
DLL.OVB_Shutdown.restype = None
DLL.OVB_OpenUrl.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint32)]
DLL.OVB_PostMessage.argtypes = [ctypes.c_uint32, ctypes.c_char_p]
DLL.OVB_Close.argtypes = [ctypes.c_uint32]
DLL.OVB_GetPopupInfo.argtypes = [ctypes.c_uint32, ctypes.POINTER(PopupInfo)]

closed = {}           # popup id -> reason (onClosed)
messages = []         # (popup id, json) from onMessage
overlay_urls = {}     # popup id -> URL with the launch token (openOverlay)
overlay_ok = [True]   # what openOverlay answers
inner = {}            # results of calls made from inside a callback
shutting_down = [False]


@OnMessage
def on_message(pid, data, user):
    messages.append((pid, data))


@OnClosed
def on_closed(pid, reason, page_reason, user):
    closed[pid] = reason
    if shutting_down[0]:   # OVB_* calls from a callback during OVB_Shutdown must be refused
        inner['open_during_shutdown'] = DLL.OVB_OpenUrl(b'https://store.example.com/x', ctypes.byref(ctypes.c_uint32()))


@OnOpened
def on_opened(pid, parent, url, user):
    pass


@OpenOverlay
def open_overlay(pid, url, user):
    overlay_urls[pid] = url.decode()
    return 1 if overlay_ok[0] else 0


# Given as a game might write it; pages send "https://store.example.com" (checks the normalization)
origins = (ctypes.c_char_p * 1)(b'HTTPS://Store.Example.com:443/')
PAGE_ORIGIN = 'https://store.example.com'
config = Config(ctypes.sizeof(Config), origins, 1, on_message, on_closed, on_opened, open_overlay, None)

failures = []


def check(what, got, expected):
    if got != expected:
        failures.append(f'{what}: got {got!r}, expected {expected!r}')
    print(('ok   ' if got == expected else 'FAIL ') + f'{what}: {got!r}')


def info(pid):
    i = PopupInfo()
    i.structSize = ctypes.sizeof(PopupInfo)
    rc = DLL.OVB_GetPopupInfo(pid, ctypes.byref(i))
    return rc, i


def open_url(url=b'https://store.example.com/event'):
    pid = ctypes.c_uint32()
    return DLL.OVB_OpenUrl(url, ctypes.byref(pid)), pid.value


class Page:
    """Plays a popup page against the DLL's server: port and key from the launch token."""

    def __init__(self, pid):
        raw = base64.urlsafe_b64decode(re.search(r'ovbk=([\w-]{47})', overlay_urls[pid]).group(1) + '=')
        self.pid, self.port = pid, int.from_bytes(raw[1:3], 'big')
        self.key = base64.urlsafe_b64encode(raw[3:]).rstrip(b'=').decode()
        self.sid, self.stream = None, None

    def post(self, path, body):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            c.request('POST', path, json.dumps(body), {'Origin': PAGE_ORIGIN, 'Content-Type': 'text/plain'})
            r = c.getresponse()
            return r.status, r.read()
        finally:
            c.close()

    def connect(self):
        status, body = self.post('/connect', {'key': self.key})
        self.sid = json.loads(body)['sid'] if status == 200 else None
        return status

    def open_stream(self):
        s = socket.create_connection(('127.0.0.1', self.port), timeout=5)
        s.sendall((f'GET /events?sid={self.sid} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n'
                   f'Origin: {PAGE_ORIGIN}\r\n\r\n').encode())
        got = b''
        while b'retry:' not in got:
            got += s.recv(4096)
        self.stream = s
        return got

    def drop_stream(self):
        self.stream.close()
        self.stream = None


def wait_until(fn, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        time.sleep(0.05)
    return False


# --- before OVB_Init ------------------------------------------------------------------------
check('OVB_OpenUrl before init', open_url()[0], ERR_STATE)
check('OVB_PostMessage before init', DLL.OVB_PostMessage(1, b'{}'), ERR_STATE)
check('OVB_GetPopupInfo before init', info(1)[0], ERR_STATE)
bad = Config(4, origins, 1, on_message, on_closed, on_opened, open_overlay, None)
check('OVB_Init with a too small structSize', DLL.OVB_Init(ctypes.byref(bad)), ERR_ARGS)
for origin in [b'https://store.example.com/path', b'ftp://store.example.com', b'store.example.com',
               b'https://store example.com', b'https://user@store.example.com', b'https://xn--hq1b.com:99999',
               'https://한글.com'.encode(), b'https://store.example.com?x', b'', None]:
    one = (ctypes.c_char_p * 1)(origin)
    cfg = Config(ctypes.sizeof(Config), one, 1, on_message, on_closed, on_opened, open_overlay, None)
    check(f'OVB_Init with allowed origin {origin!r}', DLL.OVB_Init(ctypes.byref(cfg)), ERR_ARGS)

# --- init -------------------------------------------------------------------------------------
check('OVB_Init', DLL.OVB_Init(ctypes.byref(config)), OK)
check('OVB_Init again', DLL.OVB_Init(ctypes.byref(config)), ERR_STATE)
check('OVB_OpenUrl with a non-http URL', open_url(b'javascript:alert(1)')[0], ERR_ARGS)
check('OVB_OpenUrl with a too long URL', open_url(b'https://store.example.com/' + b'a' * 2100)[0], ERR_ARGS)

rc, pid = open_url()
check('OVB_OpenUrl', rc, OK)
rc, i = info(pid)
check('OVB_GetPopupInfo state', (rc, i.state, i.keyUsed, i.canOpenPopup), (OK, WAITING, 0, 1))
small = PopupInfo()
small.structSize = 8
check('OVB_GetPopupInfo with a too small structSize', DLL.OVB_GetPopupInfo(pid, ctypes.byref(small)), ERR_ARGS)
check('OVB_GetPopupInfo unknown id', info(999999)[0], ERR_NOT_FOUND)

# --- OVB_PostMessage: JSON validation (the DLL's JSON reader) ----------------------------------
check('post to a waiting popup (no page yet)', DLL.OVB_PostMessage(pid, b'{"a":1}'), 0)
for text, rc in [
    (b'{"a":[1,2,{"b":null}],"s":"\\u00e9\\ud83d\\ude00","n":-1.5e+3}', 0),
    (b'"just a string"', 0),
    (b'null', 0),
    (b'{\r\n"a": 1\r\n}', 0),
    (b'[' * 64 + b']' * 64, 0),
    (b'[' * 66 + b']' * 66, ERR_JSON),          # deeper than the reader's 64 levels
    (b'{"a":1,}', ERR_JSON),
    (b'{"a":1} x', ERR_JSON),
    (b'{"s":"\\ud83d"}', ERR_JSON),             # lone surrogate
    (b'{"s":"tab\there"}', ERR_JSON),          # raw control character in a string
    (b'01', ERR_JSON),
    (b'', ERR_JSON),
    (b'"' + b'a' * (1024 * 1024) + b'"', ERR_JSON),   # over 1 MB
]:
    check(f'OVB_PostMessage {text[:24]!r}', DLL.OVB_PostMessage(pid, text), rc)
check('OVB_PostMessage unknown id', DLL.OVB_PostMessage(999999, b'{}'), ERR_NOT_FOUND)

# --- close ------------------------------------------------------------------------------------
check('OVB_Close waiting popup', DLL.OVB_Close(pid), OK)
DLL.OVB_Update()
check('onClosed for it', closed.get(pid), NATIVE_REQUEST)
check('OVB_Close again', DLL.OVB_Close(pid), ERR_CLOSED)
check('OVB_PostMessage to a closed popup', DLL.OVB_PostMessage(pid, b'{}'), ERR_CLOSED)

# --- with a page (raw HTTP against the popup's server) ------------------------------------------
rc, pid = open_url()
page = Page(pid)
check('page connects with the normalized allowed origin', page.connect(), 200)
page.open_stream()
check('popup open', wait_until(lambda: info(pid)[1].state == OPEN), True)

# Messages wait for OVB_Update; beyond 1024 waiting ones the page is refused (503)
DLL.OVB_Update()
messages.clear()
statuses = [page.post('/message', {'sid': page.sid, 'message': n})[0] for n in range(1025)]
check('1024 messages queued without OVB_Update', statuses[:1024].count(200), 1024)
check('the 1025th is refused', statuses[1024], 503)
DLL.OVB_Update()
check('all 1024 delivered by OVB_Update, in order', [m for _, m in messages] == [str(n).encode() for n in range(1024)], True)
check('accepted again after OVB_Update', page.post('/message', {'sid': page.sid, 'message': 'again'})[0], 200)
DLL.OVB_Update()
# ... and beyond 8 MB waiting
messages.clear()
big = 'x' * 15000
accepted = 0
while page.post('/message', {'sid': page.sid, 'message': big})[0] == 200:
    accepted += 1
check('large messages refused at 8 MB', (accepted * (len(big) + 2) <= 8 * 1024 * 1024, accepted > 500), (True, True))
DLL.OVB_Update()
check('the accepted large messages delivered', len(messages), accepted)

# A close notice is forgotten, reason text included, when the page comes back (not a close)
check('close notice', page.post('/closing', {'sid': page.sid, 'popupId': pid, 'reason': 'hidden', 'explicit': False})[0], 200)
rc, i = info(pid)
check('notice recorded', (i.hasNotice, i.noticeReason), (1, b'hidden'))
page.drop_stream()
time.sleep(0.3)   # an EventSource retry, within the grace period
page.open_stream()
rc, i = info(pid)
check('notice forgotten after the page came back', (i.state, i.hasNotice, i.noticeExplicit, i.noticeTimeMs, i.noticeReason),
      (OPEN, 0, 0, 0, b''))
DLL.OVB_Close(pid)
page.drop_stream()
check('closed', wait_until(lambda: (DLL.OVB_Update(), closed.get(pid))[1] == NATIVE_REQUEST), True)

# --- overlay failure: not reported, not kept ---------------------------------------------------
overlay_ok[0] = False
rc, failed = open_url()
check('OVB_OpenUrl when the overlay cannot open', rc, ERR_OVERLAY)
overlay_ok[0] = True

# --- limit: 64 open popups ---------------------------------------------------------------------
ids = []
for n in range(64):
    rc, p = open_url()
    if rc != OK:
        break
    ids.append(p)
check('64 popups open', len(ids), 64)
check('the 65th', open_url()[0], ERR_LIMIT)
for p in ids:
    DLL.OVB_Close(p)
DLL.OVB_Update()
check('a popup after closing them', open_url()[0], OK)

# --- shutdown, calls from its callbacks, re-init ------------------------------------------------
rc, last = open_url()
shutting_down[0] = True
DLL.OVB_Shutdown()
shutting_down[0] = False
check('onClosed SHUTDOWN for a waiting popup', closed.get(last), SHUTDOWN)
check('OVB_OpenUrl from an onClosed during OVB_Shutdown', inner.get('open_during_shutdown'), ERR_STATE)
check('OVB_PostMessage after shutdown', DLL.OVB_PostMessage(last, b'{}'), ERR_STATE)
DLL.OVB_Shutdown()   # second call: nothing to do
check('OVB_Init after shutdown', DLL.OVB_Init(ctypes.byref(config)), OK)
rc, again = open_url()
check('OVB_OpenUrl after re-init', rc, OK)
check('ids keep increasing after re-init', again > last, True)
DLL.OVB_Shutdown()

print(f'{len(failures)} failure(s)')
for f in failures:
    print('  ' + f)
sys.exit(1 if failures else 0)
