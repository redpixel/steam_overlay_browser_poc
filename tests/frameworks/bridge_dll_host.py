# Test host for the real native SDK bridge DLL (native_bridge/out/overlay_bridge.dll), test only.
# Serves the control API of bridge_control.py (like bridge_native_standin.py), so the framework
# tests run against the DLL unchanged (harness: BRIDGE_IMPL=dll). Plays the game: every OVB_* call
# and OVB_Update() run on this process's main thread; control requests are handed to it.
# Usage: python bridge_dll_host.py [extra allowed origin ...]
import ctypes, json, os, queue, threading, time
from bridge_control import ALLOWED_ORIGINS, log, make_server

DLL = ctypes.CDLL(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'native_bridge', 'out', 'overlay_bridge.dll'))
REASONS = {1: 'NATIVE_REQUEST', 2: 'PAGE_REQUEST', 3: 'CONNECTION_LOST', 4: 'NEVER_CONNECTED', 5: 'SHUTDOWN', 6: 'USER_CLOSED'}
STATES = {1: 'waiting', 2: 'open', 3: 'closed'}
OVB_OPEN_NO_CHILD_POPUPS = 0x1

OnMessage = ctypes.CFUNCTYPE(None, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_void_p)
OnClosed = ctypes.CFUNCTYPE(None, ctypes.c_uint32, ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p)
OnOpened = ctypes.CFUNCTYPE(None, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_void_p)
OpenOverlay = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_void_p)


class Config(ctypes.Structure):
    _fields_ = [('structSize', ctypes.c_uint32), ('allowedOrigins', ctypes.POINTER(ctypes.c_char_p)),
                ('allowedOriginCount', ctypes.c_uint32), ('onMessage', OnMessage), ('onClosed', OnClosed),
                ('onOpened', OnOpened), ('openOverlay', OpenOverlay), ('user', ctypes.c_void_p)]


class OpenOptions(ctypes.Structure):
    _fields_ = [('structSize', ctypes.c_uint32), ('url', ctypes.c_char_p), ('flags', ctypes.c_uint32),
                ('connectTimeoutMs', ctypes.c_uint32)]


class PopupInfo(ctypes.Structure):
    _fields_ = [('structSize', ctypes.c_uint32), ('state', ctypes.c_uint32), ('closeReason', ctypes.c_uint32),
                ('parentPopupId', ctypes.c_uint32), ('keyUsed', ctypes.c_uint32), ('streams', ctypes.c_uint32),
                ('canOpenPopup', ctypes.c_uint32), ('hasNotice', ctypes.c_uint32), ('noticeExplicit', ctypes.c_uint32),
                ('noticeTimeMs', ctypes.c_uint64), ('noticeReason', ctypes.c_char * 260)]


DLL.OVB_Init.argtypes = [ctypes.POINTER(Config)]
DLL.OVB_Update.argtypes = []
DLL.OVB_Update.restype = None
DLL.OVB_Shutdown.argtypes = []
DLL.OVB_Shutdown.restype = None
DLL.OVB_OpenUrlEx.argtypes = [ctypes.POINTER(OpenOptions), ctypes.POINTER(ctypes.c_uint32)]
DLL.OVB_PostMessage.argtypes = [ctypes.c_uint32, ctypes.c_char_p]
DLL.OVB_Close.argtypes = [ctypes.c_uint32]
DLL.OVB_GetPopupInfo.argtypes = [ctypes.c_uint32, ctypes.POINTER(PopupInfo)]

sessions = {}          # id -> host-side record (web messages, close reported by onClosed, child launch)
opened_urls = {}       # id -> url the DLL asked to show (openOverlay)
lock = threading.Lock()
commands = queue.Queue()


def record(pid):
    return sessions.setdefault(pid, {'web_messages': [], 'parent': None, 'launched': True, 'closed': None})


@OnMessage
def on_message(pid, data, user):
    text = data.decode()
    try:
        message = json.loads(text)
    except ValueError:   # recorded as is: a parse failure here must not lose the message
        message = {'unparsed': text}
    with lock:
        record(pid)['web_messages'].append(message)
    log(f'[{pid}] WEB -> NATIVE  {text}')


@OnClosed
def on_closed(pid, reason, page_reason, user):
    # Kept for /status after OVB_Shutdown, when the DLL no longer knows the popup
    with lock:
        record(pid)['closed'] = {'reason': REASONS.get(reason, reason), 'page_reason': page_reason and page_reason.decode()}
    log(f'[{pid}] *** onClosed(popupId={pid}, {REASONS.get(reason, reason)}) page reason: {page_reason and page_reason.decode()!r}')


@OnOpened
def on_opened(pid, parent, url, user):
    log(f'[{pid}] *** onOpened(popupId={pid}, parent={parent}, {url.decode()})')


@OpenOverlay
def open_overlay(pid, url, user):
    # The real game shows the URL in the Steam overlay; here the test opens it in a browser
    with lock:
        opened_urls[pid] = url.decode()
        info = popup_info(pid)
        if info and info['parent']:
            r = record(pid)
            r['parent'] = info['parent']
            r['launched'] = False      # waits for the test to open it (POST /launched)
    return 1


def popup_info(pid):
    info = PopupInfo()
    info.structSize = ctypes.sizeof(PopupInfo)
    if DLL.OVB_GetPopupInfo(pid, ctypes.byref(info)) != 0:
        return None
    notice = None
    if info.hasNotice:
        notice = {'reason': info.noticeReason.decode(), 'explicit': bool(info.noticeExplicit), 'at': info.noticeTimeMs / 1000.0}
    return {'state': STATES.get(info.state), 'close_reason': REASONS.get(info.closeReason), 'parent': info.parentPopupId or None,
            'key_used': bool(info.keyUsed), 'streams': info.streams, 'can_open_popup': bool(info.canOpenPopup), 'page_notice': notice}


origins = (ctypes.c_char_p * len(ALLOWED_ORIGINS))(*[o.encode() for o in ALLOWED_ORIGINS])
config = Config(ctypes.sizeof(Config), origins, len(ALLOWED_ORIGINS), on_message, on_closed, on_opened, open_overlay, None)


def init():
    rc = DLL.OVB_Init(ctypes.byref(config))
    assert rc == 0, f'OVB_Init failed: {rc}'


def run_on_main(fn):
    done = threading.Event()
    box = {}
    commands.put((fn, done, box))
    done.wait()
    if 'error' in box:
        raise box['error']
    return box['result']


class DllBackend:
    """The control API (bridge_control.py) on top of the DLL. DLL calls run on the main thread."""

    def new(self, base, timeout, can_open):
        def call():
            opts = OpenOptions(ctypes.sizeof(OpenOptions), base.encode(), OVB_OPEN_NO_CHILD_POPUPS if can_open is False else 0,
                               int(timeout * 1000) if timeout is not None else 0)
            pid = ctypes.c_uint32()
            rc = DLL.OVB_OpenUrlEx(ctypes.byref(opts), ctypes.byref(pid))
            if rc != 0:
                raise RuntimeError(f'OVB_OpenUrlEx -> {rc}')
            with lock:
                record(pid.value)
                return pid.value, opened_urls[pid.value]
        return run_on_main(call)

    def known(self, pid):
        with lock:
            return pid in sessions

    def latest(self):
        with lock:
            return max(sessions) if sessions else None

    def launched(self, pid):
        with lock:
            sessions[pid]['launched'] = True
        return True

    def shutdown(self):
        def call():
            DLL.OVB_Shutdown()   # every popup gets onClosed (recorded above) before this returns
            init()               # and the next tests go on with a fresh bridge
        run_on_main(call)

    def send(self, pid, raw):
        rc = run_on_main(lambda: DLL.OVB_PostMessage(pid, raw))
        log(f'[{pid}] NATIVE -> WEB  message {raw.decode()} -> {rc}')
        return rc

    def close(self, pid):
        return run_on_main(lambda: DLL.OVB_Close(pid))

    def pending(self):
        # Children the DLL asked to show that the test has not opened yet (POST /launched)
        def call():
            with lock:
                return [{'id': pid, 'url': opened_urls.get(pid), 'parent': r['parent']} for pid, r in sessions.items()
                        if not r['launched'] and r['parent'] and (popup_info(pid) or {}).get('state') == 'waiting']
        return run_on_main(call)

    def status(self):
        def call():
            out = {}
            with lock:
                for pid, r in sorted(sessions.items()):
                    info = popup_info(pid)
                    if not info and r['closed']:
                        c = r['closed']
                        info = {'state': 'closed', 'close_reason': c['reason'], 'parent': r['parent'], 'key_used': None,
                                'streams': 0, 'can_open_popup': None,
                                'page_notice': {'reason': c['page_reason']} if c['page_reason'] else None}
                    if info:
                        out[str(pid)] = dict(info, web_messages=list(r['web_messages']), launched=r['launched'])
            return out
        return run_on_main(call)


if __name__ == '__main__':
    init()
    threading.Thread(target=make_server(DllBackend()).serve_forever, daemon=True).start()
    while True:   # the game's main loop
        try:
            while True:
                fn, done, box = commands.get_nowait()
                try:
                    box['result'] = fn()
                except Exception as e:   # reported to the caller
                    box['error'] = e
                done.set()
        except queue.Empty:
            pass
        DLL.OVB_Update()
        time.sleep(0.005)
