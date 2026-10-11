/*
 * ovb_bridge.cpp - OverlayBridge overlay bridge (PoC). See ovb_bridge.h.
 *
 * One bridge thread serves every popup's local server (Winsock, select). The Python stand-in
 * (tests/frameworks/bridge_native_standin.py) follows the same rules for tests; the framework tests
 * run against this DLL. Work that must run on the game's main thread (opening child popups,
 * callbacks) is queued and done in OVB_Update().
 */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define FD_SETSIZE 1024
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "ovb_bridge.h"
#include "ovb_token.h"   // compiled into this DLL, not exported (no OVB_BUILD_DLL here)

#pragma comment(lib, "ws2_32.lib")

namespace {

const uint64_t kGraceMs = 1000;           // a dropped stream may come back within this: EventSource retries after
const int kSseRetryMs = 200;              // kSseRetryMs ('retry:' line), which must stay well below kGraceMs
const uint64_t kNoticeWindowMs = 5000;    // a close notice only counts if the stream drops this soon after it
const uint64_t kDefaultConnectTimeoutMs = 300000;
const uint64_t kKeepAliveMs = 15000;      // SSE comment line so idle streams stay open
const uint64_t kRequestTimeoutMs = 10000; // a plain request must arrive whole within this
const uint64_t kShutdownWaitMs = 3000;    // OVB_Shutdown waits this long for pages to close themselves
const size_t kMaxHeader = 8 * 1024;
const size_t kMaxBody = 16 * 1024;
const size_t kMaxUrl = 2048;
const size_t kMaxConnsPerPopup = 32;
const size_t kMaxPostJson = 1024 * 1024;
const size_t kMaxConnOut = 4 * 1024 * 1024;   // unsent data per event stream before it is dropped
const size_t kMaxLivePopups = 64;             // not closed, all popups
const size_t kMaxChildrenPerPopup = 8;        // not closed, per parent
const size_t kMaxQueuedMessages = 1024;       // page messages waiting for OVB_Update; more are refused (503)
const size_t kMaxQueuedMessageBytes = 8 * 1024 * 1024;
const uint64_t kLingerMs = 60000;         // a popup closed while its page was loading keeps serving this long,
const size_t kMaxLingering = 16;          // so the page is told to close once it connects (at most this many)
const int kMaxJsonDepth = 64;
const int kOverlayModeModal = 1;          // k_EActivateGameOverlayToWebPageMode_Modal

uint64_t NowMs() { return GetTickCount64(); }

//-----------------------------------------------------------------------------
// Small JSON reader: top-level object members as raw spans, strings decoded.
// Recursion is bounded by kMaxJsonDepth.
//-----------------------------------------------------------------------------
struct JsonCursor
{
    const char *p;
    const char *end;
};

void SkipWs(JsonCursor &c)
{
    while (c.p < c.end && (*c.p == ' ' || *c.p == '\t' || *c.p == '\r' || *c.p == '\n'))
        ++c.p;
}

bool HexValue(char ch, unsigned *v)
{
    if (ch >= '0' && ch <= '9') { *v = (unsigned)(ch - '0'); return true; }
    if (ch >= 'a' && ch <= 'f') { *v = (unsigned)(ch - 'a' + 10); return true; }
    if (ch >= 'A' && ch <= 'F') { *v = (unsigned)(ch - 'A' + 10); return true; }
    return false;
}

void AppendUtf8(std::string *out, unsigned cp)
{
    if (cp < 0x80) out->push_back((char)cp);
    else if (cp < 0x800) { out->push_back((char)(0xC0 | (cp >> 6))); out->push_back((char)(0x80 | (cp & 0x3F))); }
    else if (cp < 0x10000) { out->push_back((char)(0xE0 | (cp >> 12))); out->push_back((char)(0x80 | ((cp >> 6) & 0x3F))); out->push_back((char)(0x80 | (cp & 0x3F))); }
    else { out->push_back((char)(0xF0 | (cp >> 18))); out->push_back((char)(0x80 | ((cp >> 12) & 0x3F))); out->push_back((char)(0x80 | ((cp >> 6) & 0x3F))); out->push_back((char)(0x80 | (cp & 0x3F))); }
}

bool ReadHex4(JsonCursor &c, unsigned *v)
{
    if (c.end - c.p < 4) return false;
    unsigned r = 0;
    for (int i = 0; i < 4; ++i)
    {
        unsigned h;
        if (!HexValue(c.p[i], &h)) return false;
        r = (r << 4) | h;
    }
    c.p += 4;
    *v = r;
    return true;
}

// c.p at the opening quote. out may be NULL (validate only).
bool ParseString(JsonCursor &c, std::string *out)
{
    if (c.p >= c.end || *c.p != '"') return false;
    ++c.p;
    while (c.p < c.end)
    {
        unsigned char ch = (unsigned char)*c.p++;
        if (ch == '"') return true;
        if (ch < 0x20) return false;
        if (ch != '\\') { if (out) out->push_back((char)ch); continue; }
        if (c.p >= c.end) return false;
        char e = *c.p++;
        switch (e)
        {
        case '"': case '\\': case '/': if (out) out->push_back(e); break;
        case 'b': if (out) out->push_back('\b'); break;
        case 'f': if (out) out->push_back('\f'); break;
        case 'n': if (out) out->push_back('\n'); break;
        case 'r': if (out) out->push_back('\r'); break;
        case 't': if (out) out->push_back('\t'); break;
        case 'u':
        {
            unsigned cp;
            if (!ReadHex4(c, &cp)) return false;
            if (cp >= 0xD800 && cp <= 0xDBFF)
            {
                unsigned lo;
                if (c.end - c.p < 6 || c.p[0] != '\\' || c.p[1] != 'u') return false;
                c.p += 2;
                if (!ReadHex4(c, &lo) || lo < 0xDC00 || lo > 0xDFFF) return false;
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            }
            else if (cp >= 0xDC00 && cp <= 0xDFFF)
                return false;
            if (out) AppendUtf8(out, cp);
            break;
        }
        default:
            return false;
        }
    }
    return false;
}

bool SkipValue(JsonCursor &c, int depth);

bool SkipNumber(JsonCursor &c)
{
    const char *start = c.p;
    if (c.p < c.end && *c.p == '-') ++c.p;
    if (c.p >= c.end) return false;
    if (*c.p == '0') ++c.p;
    else if (*c.p >= '1' && *c.p <= '9') { while (c.p < c.end && *c.p >= '0' && *c.p <= '9') ++c.p; }
    else return false;
    if (c.p < c.end && *c.p == '.')
    {
        ++c.p;
        if (c.p >= c.end || *c.p < '0' || *c.p > '9') return false;
        while (c.p < c.end && *c.p >= '0' && *c.p <= '9') ++c.p;
    }
    if (c.p < c.end && (*c.p == 'e' || *c.p == 'E'))
    {
        ++c.p;
        if (c.p < c.end && (*c.p == '+' || *c.p == '-')) ++c.p;
        if (c.p >= c.end || *c.p < '0' || *c.p > '9') return false;
        while (c.p < c.end && *c.p >= '0' && *c.p <= '9') ++c.p;
    }
    return c.p > start;
}

bool SkipLiteral(JsonCursor &c, const char *lit)
{
    size_t n = strlen(lit);
    if ((size_t)(c.end - c.p) < n || memcmp(c.p, lit, n) != 0) return false;
    c.p += n;
    return true;
}

bool SkipValue(JsonCursor &c, int depth)
{
    if (depth > kMaxJsonDepth) return false;
    SkipWs(c);
    if (c.p >= c.end) return false;
    char ch = *c.p;
    if (ch == '"') return ParseString(c, NULL);
    if (ch == '{' || ch == '[')
    {
        char close = ch == '{' ? '}' : ']';
        ++c.p;
        SkipWs(c);
        if (c.p < c.end && *c.p == close) { ++c.p; return true; }
        for (;;)
        {
            if (ch == '{')
            {
                SkipWs(c);
                if (!ParseString(c, NULL)) return false;
                SkipWs(c);
                if (c.p >= c.end || *c.p != ':') return false;
                ++c.p;
            }
            if (!SkipValue(c, depth + 1)) return false;
            SkipWs(c);
            if (c.p >= c.end) return false;
            if (*c.p == ',') { ++c.p; continue; }
            if (*c.p == close) { ++c.p; return true; }
            return false;
        }
    }
    if (ch == 't') return SkipLiteral(c, "true");
    if (ch == 'f') return SkipLiteral(c, "false");
    if (ch == 'n') return SkipLiteral(c, "null");
    return SkipNumber(c);
}

bool IsJsonValue(const char *s, size_t n)
{
    JsonCursor c{s, s + n};
    if (!SkipValue(c, 0)) return false;
    SkipWs(c);
    return c.p == c.end;
}

struct JsonMember
{
    std::string key;
    std::string raw;    // the value's JSON text
};

// The whole text must be exactly one JSON object: its keys decoded, values kept as JSON text.
bool ParseObject(const std::string &text, std::vector<JsonMember> *members)
{
    JsonCursor c{text.data(), text.data() + text.size()};
    SkipWs(c);
    if (c.p >= c.end || *c.p != '{') return false;
    ++c.p;
    SkipWs(c);
    if (c.p < c.end && *c.p == '}')
        ++c.p;
    else
    {
        for (;;)
        {
            JsonMember m;
            SkipWs(c);
            if (!ParseString(c, &m.key)) return false;
            SkipWs(c);
            if (c.p >= c.end || *c.p != ':') return false;
            ++c.p;
            SkipWs(c);
            const char *value = c.p;
            if (!SkipValue(c, 1)) return false;
            m.raw.assign(value, c.p);
            members->push_back(std::move(m));
            SkipWs(c);
            if (c.p >= c.end) return false;
            if (*c.p == ',') { ++c.p; continue; }
            if (*c.p != '}') return false;
            ++c.p;
            break;
        }
    }
    SkipWs(c);
    return c.p == c.end;
}

const JsonMember *FindMember(const std::vector<JsonMember> &members, const char *key)
{
    for (const JsonMember &m : members)
        if (m.key == key) return &m;
    return NULL;
}

bool MemberString(const std::vector<JsonMember> &members, const char *key, std::string *out)
{
    const JsonMember *m = FindMember(members, key);
    if (!m || m->raw.empty() || m->raw[0] != '"') return false;
    JsonCursor c{m->raw.data(), m->raw.data() + m->raw.size()};
    return ParseString(c, out);
}

std::string JsonQuote(const std::string &s)
{
    std::string out = "\"";
    for (unsigned char ch : s)
    {
        if (ch == '"' || ch == '\\') { out.push_back('\\'); out.push_back((char)ch); }
        else if (ch < 0x20) { char buf[8]; sprintf_s(buf, "\\u%04x", ch); out += buf; }
        else out.push_back((char)ch);
    }
    return out + "\"";
}

size_t Utf8Length(const std::string &s)
{
    size_t n = 0;
    for (unsigned char ch : s)
        if ((ch & 0xC0) != 0x80) ++n;
    return n;
}

std::string Base64Url(const uint8_t *in, size_t len)
{
    std::string out((len + 2) / 3 * 4 + 1, '\0');
    out.resize(ovb_base64url(in, len, &out[0]));
    return out;
}

bool ConstantTimeEquals(const std::string &a, const std::string &b)
{
    if (a.size() != b.size() || a.empty()) return false;
    unsigned char diff = 0;
    for (size_t i = 0; i < a.size(); ++i)
        diff |= (unsigned char)(a[i] ^ b[i]);
    return diff == 0;
}

// The origin of an http(s) URL as a browser sends it in the Origin header: "scheme://host[:port]",
// lower case, without the default port. Empty when the URL is not http(s) or its host is not plain
// ASCII (user info, percent escapes and non-ASCII names are refused; give IDNs in punycode).
// *rest gets where the path / query / fragment starts.
std::string UrlOrigin(const std::string &url, size_t *rest = NULL)
{
    size_t schemeEnd = url.find("://");
    if (schemeEnd == std::string::npos) return std::string();
    std::string scheme = url.substr(0, schemeEnd);
    for (char &ch : scheme) ch = (char)tolower((unsigned char)ch);
    if (scheme != "http" && scheme != "https") return std::string();
    size_t hostStart = schemeEnd + 3;
    size_t hostEnd = url.find_first_of("/?#\\", hostStart);   // browsers treat '\' as '/' in http(s) URLs
    if (hostEnd == std::string::npos) hostEnd = url.size();
    if (rest) *rest = hostEnd;
    std::string host = url.substr(hostStart, hostEnd - hostStart), port;
    for (char &ch : host) ch = (char)tolower((unsigned char)ch);
    size_t colon = host.rfind(':');
    if (colon != std::string::npos && host.find(']', colon) == std::string::npos)
    {
        port = host.substr(colon + 1);
        host.resize(colon);
    }
    if (host.empty()) return std::string();
    bool ipv6 = host[0] == '[';
    if (ipv6 && (host.size() < 4 || host.back() != ']' || host.find_first_not_of("0123456789abcdef:.", 1) != host.size() - 1))
        return std::string();
    if (!ipv6 && host.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789.-_") != std::string::npos)
        return std::string();
    if (colon != std::string::npos)
    {
        if (port.empty() || port.size() > 5 || port.find_first_not_of("0123456789") != std::string::npos) return std::string();
        unsigned long n = strtoul(port.c_str(), NULL, 10);
        if (n == 0 || n > 65535) return std::string();
        port = (n == 80 && scheme == "http") || (n == 443 && scheme == "https") ? std::string() : std::to_string(n);
    }
    return scheme + "://" + host + (port.empty() ? "" : ":" + port);
}

std::string PercentDecode(const std::string &s)
{
    std::string out;
    for (size_t i = 0; i < s.size(); ++i)
    {
        unsigned hi, lo;
        if (s[i] == '%' && i + 2 < s.size() && HexValue(s[i + 1], &hi) && HexValue(s[i + 2], &lo))
        {
            out.push_back((char)((hi << 4) | lo));
            i += 2;
        }
        else if (s[i] == '+')
            out.push_back(' ');
        else
            out.push_back(s[i]);
    }
    return out;
}

std::string QueryParam(const std::string &query, const char *name)
{
    size_t pos = 0;
    std::string prefix = std::string(name) + "=";
    while (pos <= query.size())
    {
        size_t amp = query.find('&', pos);
        std::string part = query.substr(pos, amp == std::string::npos ? std::string::npos : amp - pos);
        if (part.compare(0, prefix.size(), prefix) == 0)
            return PercentDecode(part.substr(prefix.size()));
        if (amp == std::string::npos) break;
        pos = amp + 1;
    }
    return std::string();
}

// json is valid JSON, so CR and LF in it can only be whitespace between tokens: turning them into
// spaces keeps the value and gives a single 'data:' line (a lone CR would end an SSE line early).
std::string SseEvent(const char *name, std::string json)
{
    std::replace(json.begin(), json.end(), '\r', ' ');
    std::replace(json.begin(), json.end(), '\n', ' ');
    return std::string("event: ") + name + "\ndata: " + json + "\n\n";
}

//-----------------------------------------------------------------------------
// State
//-----------------------------------------------------------------------------
struct Popup
{
    uint32_t id = 0;
    uint32_t parent = 0;
    SOCKET listener = INVALID_SOCKET;
    uint16_t port = 0;
    std::string key;            // one-time key, base64url
    std::string sid;            // session id after /connect
    std::string url;            // target URL + launch token
    std::string target;         // URL as given (no token)
    OVB_PopupState state = OVB_POPUP_WAITING;
    bool hidden = false;        // the overlay could not be opened: never reported
    bool launched = true;       // child popups wait for OVB_Update to open them
    bool canOpen = true;
    bool keyUsed = false;
    bool closeRequested = false;
    bool shuttingDown = false;
    uint64_t created = 0;
    uint64_t connectTimeout = kDefaultConnectTimeoutMs;
    uint64_t disconnectedAt = 0;
    bool hasNotice = false;
    bool noticeExplicit = false;
    uint64_t noticeAt = 0;
    std::string noticeReason;
    OVB_CloseReason reason = (OVB_CloseReason)0;
    bool lingering = false;     // closed and reported, but still serving a page that may yet connect
    bool lingerStreamSeen = false;
    uint64_t lingerUntil = 0;
};

struct Conn
{
    SOCKET s = INVALID_SOCKET;
    uint32_t popupId = 0;
    std::string in;
    std::string out;
    bool sse = false;
    bool closeAfterWrite = false;
    bool dead = false;
    bool overflow = false;      // the page stopped reading: dropped by the bridge thread
    uint64_t since = 0;
    uint64_t lastWrite = 0;
};

enum EventType { EV_MESSAGE, EV_CLOSED, EV_OPENED };

struct Event
{
    EventType type;
    uint32_t id;
    uint32_t parent;
    OVB_CloseReason reason;
    bool hasText;
    std::string text;
};

typedef void *(__cdecl *PfnSteamFriends)();
typedef void (__cdecl *PfnActivateWebPage)(void *self, const char *url, int mode);
typedef void *(__cdecl *PfnSteamUtils)();
typedef bool (__cdecl *PfnIsOnDeck)(void *self);
typedef bool (__cdecl *PfnIsOverlayEnabled)(void *self);

std::mutex g_mutex;
bool g_initialized = false;
bool g_inCallback = false;
bool g_shuttingDown = false;   // OVB_Shutdown is running: other calls (e.g. from its callbacks) are refused
OVB_Config g_config;
std::vector<std::string> g_origins;
std::map<uint32_t, std::unique_ptr<Popup>> g_popups;
std::vector<std::unique_ptr<Conn>> g_conns;
std::deque<Event> g_events;
size_t g_queuedMessages = 0;        // EV_MESSAGE entries in g_events and their size
size_t g_queuedMessageBytes = 0;
std::deque<uint32_t> g_toLaunch;
HANDLE g_thread = NULL;   // the bridge thread; it holds a reference on this DLL (BridgeThreadMain)
std::atomic<bool> g_stop(false);
uint32_t g_nextId = 1;
bool g_wsa = false;

PfnSteamFriends g_steamFriends = NULL;
PfnActivateWebPage g_activateWebPage = NULL;
bool g_onDeck = false;
bool g_overlayDisabled = false;   // Steam says its overlay is off (unknown counts as on)

// Looked up on every use, never cached: the game may load or initialize Steam after OVB_Init, and
// SteamAPI_SteamUtils_v010() returns NULL until SteamAPI_Init (so the Deck check is repeated too).
void ResolveSteam()
{
    g_steamFriends = NULL;
    g_activateWebPage = NULL;
    g_onDeck = false;
    g_overlayDisabled = false;
#ifdef _WIN64
    HMODULE steam = GetModuleHandleW(L"steam_api64.dll");
#else
    HMODULE steam = GetModuleHandleW(L"steam_api.dll");
#endif
    if (!steam) return;
    // The accessor name carries the interface version of the game's SDK (v018 in SDK 1.62; an older
    // SDK may only have v017). The flat functions come from the same DLL, so they match it.
    for (const char *name : {"SteamAPI_SteamFriends_v018", "SteamAPI_SteamFriends_v017"})
        if (!g_steamFriends) g_steamFriends = (PfnSteamFriends)(void *)GetProcAddress(steam, name);
    g_activateWebPage = (PfnActivateWebPage)(void *)GetProcAddress(steam, "SteamAPI_ISteamFriends_ActivateGameOverlayToWebPage");
    PfnSteamUtils steamUtils = (PfnSteamUtils)(void *)GetProcAddress(steam, "SteamAPI_SteamUtils_v010");
    PfnIsOnDeck isOnDeck = (PfnIsOnDeck)(void *)GetProcAddress(steam, "SteamAPI_ISteamUtils_IsSteamRunningOnSteamDeck");
    PfnIsOverlayEnabled isOverlayEnabled =
        (PfnIsOverlayEnabled)(void *)GetProcAddress(steam, "SteamAPI_ISteamUtils_IsOverlayEnabled");
    void *utils = steamUtils ? steamUtils() : NULL;
    if (utils && isOnDeck) g_onDeck = isOnDeck(utils);
    // With the overlay off, ActivateGameOverlayToWebPage shows nothing and reports nothing
    // (checked on desktop Steam): the page would only time out as NEVER_CONNECTED
    if (utils && isOverlayEnabled) g_overlayDisabled = !isOverlayEnabled(utils);
}

// Main thread, no lock held
bool OpenInOverlay(uint32_t id, const std::string &url)
{
    if (g_config.openOverlay)
    {
        g_inCallback = true;   // a user callback: no OVB_Update / OVB_Shutdown from inside it
        bool shown = g_config.openOverlay(id, url.c_str(), g_config.user) != 0;
        g_inCallback = false;
        return shown;
    }
    ResolveSteam();
    if (!g_steamFriends || !g_activateWebPage || g_overlayDisabled) return false;
    void *friends = g_steamFriends();
    if (!friends) return false;
    g_activateWebPage(friends, url.c_str(), kOverlayModeModal);
    return true;
}

Popup *FindPopup(uint32_t id)
{
    auto it = g_popups.find(id);
    return it == g_popups.end() || it->second->hidden ? NULL : it->second.get();
}

size_t StreamCount(uint32_t popupId)
{
    size_t n = 0;
    for (auto &c : g_conns)
        if (c->sse && !c->dead && c->popupId == popupId) ++n;
    return n;
}

int PushToStreams(uint32_t popupId, const std::string &event)
{
    int n = 0;
    uint64_t now = NowMs();
    for (auto &c : g_conns)
    {
        if (!c->sse || c->dead || c->overflow || c->popupId != popupId) continue;
        if (c->out.size() + event.size() > kMaxConnOut)
        {
            c->overflow = true;   // the page is not reading: drop the stream (normal close detection follows)
            continue;
        }
        c->out += event;
        c->lastWrite = now;
        ++n;
    }
    return n;
}

size_t LivePopups(uint32_t parent, bool anyParent)
{
    size_t n = 0;
    for (auto &kv : g_popups)
        if (!kv.second->hidden && kv.second->state != OVB_POPUP_CLOSED && (anyParent || kv.second->parent == parent)) ++n;
    return n;
}

const std::string &CloseEvent()
{
    static const std::string event = SseEvent("close", "null");
    return event;
}

void RequestClose(Popup *p, OVB_CloseReason ifWaiting);

void MarkClosed(Popup *p, OVB_CloseReason reason)
{
    if (p->state == OVB_POPUP_CLOSED) return;
    p->state = OVB_POPUP_CLOSED;
    p->reason = reason;
    if (!p->launched)
    {
        // A child the game never showed (and never got onOpened for): not reported at all
        p->hidden = true;
        return;
    }
    Event e{EV_CLOSED, p->id, p->parent, reason, p->hasNotice, p->hasNotice ? p->noticeReason : std::string()};
    g_events.push_back(std::move(e));
    // Its children close too
    for (auto &kv : g_popups)
    {
        Popup *c = kv.second.get();
        if (c->hidden || c->parent != p->id || c->state == OVB_POPUP_CLOSED) continue;
        c->closeRequested = true;
        RequestClose(c, OVB_CLOSE_NATIVE_REQUEST);
    }
}

size_t LingeringCount()
{
    size_t n = 0;
    for (auto &kv : g_popups)
        if (kv.second->lingering) ++n;
    return n;
}

// Closes a popup whose page has not connected yet at once (reason ifWaiting); otherwise asks the
// page to close itself, and the stream drop that follows reports it.
// A page still loading would stay on screen, so its server lingers (kLingerMs) and tells the page
// to close as soon as it connects. Not while shutting down: the servers stop then.
void RequestClose(Popup *p, OVB_CloseReason ifWaiting)
{
    if (p->state != OVB_POPUP_WAITING)
    {
        PushToStreams(p->id, CloseEvent());
        return;
    }
    MarkClosed(p, ifWaiting);
    if (!p->hidden && !p->shuttingDown && !g_shuttingDown && LingeringCount() < kMaxLingering)
    {
        p->lingering = true;
        p->lingerUntil = NowMs() + kLingerMs;
    }
}

bool IsAllowedOrigin(const std::string &origin)
{
    return !origin.empty() && std::find(g_origins.begin(), g_origins.end(), origin) != g_origins.end();
}

OVB_CloseReason ResolveReason(const Popup *p)
{
    if (p->shuttingDown) return OVB_CLOSE_SHUTDOWN;
    if (p->closeRequested) return OVB_CLOSE_NATIVE_REQUEST;
    if (p->hasNotice && p->disconnectedAt && (int64_t)p->disconnectedAt - (int64_t)p->noticeAt <= (int64_t)kNoticeWindowMs)
        return p->noticeExplicit ? OVB_CLOSE_PAGE_REQUEST : OVB_CLOSE_USER_CLOSED;
    return OVB_CLOSE_CONNECTION_LOST;
}

// Creates a popup with its listening socket (any thread, lock held). NULL on failure.
Popup *CreatePopup(const std::string &target, uint32_t parent, bool canOpen, uint64_t connectTimeout, int *err)
{
    std::unique_ptr<Popup> p(new Popup);
    uint8_t key[OVB_KEY_BYTES];
    if (ovb_random(key, sizeof(key)) != 0) { *err = OVB_BRIDGE_ERR_RANDOM; return NULL; }
    p->key = Base64Url(key, sizeof(key));

    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) { *err = OVB_BRIDGE_ERR_NETWORK; return NULL; }
    sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);   // loopback only: no firewall prompt, no LAN exposure
    addr.sin_port = 0;
    BOOL exclusive = TRUE;
    setsockopt(s, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&exclusive, sizeof(exclusive));
    int len = sizeof(addr);
    u_long nonBlocking = 1;
    if (bind(s, (sockaddr *)&addr, sizeof(addr)) != 0 || listen(s, 16) != 0 ||
        getsockname(s, (sockaddr *)&addr, &len) != 0 || ioctlsocket(s, FIONBIO, &nonBlocking) != 0)
    {
        closesocket(s);
        *err = OVB_BRIDGE_ERR_NETWORK;
        return NULL;
    }
    p->listener = s;
    p->port = ntohs(addr.sin_port);

    std::vector<char> url(target.size() + 128);
    if (ovb_build_popup_url(target.c_str(), p->port, key, url.data(), url.size()) != 0)
    {
        closesocket(s);
        *err = OVB_BRIDGE_ERR_ARGS;
        return NULL;
    }
    SecureZeroMemory(key, sizeof(key));
    p->url = url.data();
    p->target = target;
    p->id = g_nextId++;
    p->parent = parent;
    p->canOpen = canOpen;
    p->connectTimeout = connectTimeout;
    p->created = NowMs();
    Popup *raw = p.get();
    g_popups[raw->id] = std::move(p);
    return raw;
}

//-----------------------------------------------------------------------------
// HTTP (bridge thread, lock held)
//-----------------------------------------------------------------------------
struct Request
{
    std::string method;
    std::string path;
    std::string query;
    std::map<std::string, std::string> headers;   // lower-case names
    std::string body;
};

void Deny(Conn *c)
{
    c->out = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    c->closeAfterWrite = true;
}

std::string Cors(const std::string &origin)
{
    return "Access-Control-Allow-Origin: " + origin + "\r\nVary: Origin\r\nAccess-Control-Allow-Private-Network: true\r\n";
}

void JsonReply(Conn *c, const std::string &origin, const std::string &json)
{
    c->out = "HTTP/1.1 200 OK\r\n" + Cors(origin) + "Content-Type: application/json\r\nContent-Length: " +
             std::to_string(json.size()) + "\r\nConnection: close\r\n\r\n" + json;
    c->closeAfterWrite = true;
}

void HandleRequest(Conn *c, Popup *p, const Request &req)
{
    auto header = [&req](const char *name) -> std::string {
        auto it = req.headers.find(name);
        return it == req.headers.end() ? std::string() : it->second;
    };
    // DNS rebinding guard, then the origin allow list
    if (header("host") != "127.0.0.1:" + std::to_string(p->port)) return Deny(c);
    std::string origin = header("origin");
    if (!IsAllowedOrigin(origin)) return Deny(c);

    if (req.method == "OPTIONS")
    {
        c->out = "HTTP/1.1 204 No Content\r\n" + Cors(origin) +
                 "Access-Control-Allow-Methods: POST, GET\r\nAccess-Control-Allow-Headers: Content-Type\r\n"
                 "Access-Control-Max-Age: 600\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        c->closeAfterWrite = true;
        return;
    }

    if (req.method == "GET")
    {
        if (req.path != "/events" || p->sid.empty() || !ConstantTimeEquals(QueryParam(req.query, "sid"), p->sid))
            return Deny(c);
        bool reconnect = p->state == OVB_POPUP_OPEN;
        c->sse = true;
        c->out = "HTTP/1.1 200 OK\r\n" + Cors(origin) + "Content-Type: text/event-stream\r\nCache-Control: no-store\r\n\r\n"
                 "retry: " + std::to_string(kSseRetryMs) + "\n\n";
        c->lastWrite = NowMs();
        p->disconnectedAt = 0;
        if (p->state == OVB_POPUP_WAITING)
            p->state = OVB_POPUP_OPEN;
        else if (p->state == OVB_POPUP_CLOSED)
            p->lingerStreamSeen = true;   // closed while loading: told to close below, stops serving once it goes
        else if (reconnect)
        {
            // the page came back: its notice was not a close
            p->hasNotice = false;
            p->noticeExplicit = false;
            p->noticeAt = 0;
            p->noticeReason.clear();
        }
        if (p->closeRequested || p->shuttingDown)
            c->out += CloseEvent();
        return;
    }

    if (req.method != "POST") return Deny(c);
    std::vector<JsonMember> body;
    if (req.body.empty() || req.body.size() > kMaxBody || !ParseObject(req.body, &body)) return Deny(c);
    std::string sid;
    bool sidOk = MemberString(body, "sid", &sid) && !p->sid.empty() && ConstantTimeEquals(sid, p->sid);

    if (req.path == "/connect")
    {
        std::string key;
        if (p->keyUsed || !MemberString(body, "key", &key) || !ConstantTimeEquals(key, p->key)) return Deny(c);
        uint8_t raw[32];
        if (ovb_random(raw, sizeof(raw)) != 0) return Deny(c);
        p->keyUsed = true;
        p->sid = Base64Url(raw, sizeof(raw));
        SecureZeroMemory(raw, sizeof(raw));
        return JsonReply(c, origin, "{\"sid\":" + JsonQuote(p->sid) + ",\"popupId\":" + std::to_string(p->id) +
                                        ",\"canOpenPopup\":" + (p->canOpen ? "true" : "false") + "}");
    }
    if (p->state == OVB_POPUP_CLOSED) return Deny(c);   // lingering (closed while loading): only connect and close
    if (req.path == "/message")
    {
        const JsonMember *message = FindMember(body, "message");
        if (!sidOk || !message) return Deny(c);
        // The game is not calling OVB_Update (paused, loading): refuse rather than queue without limit
        if (g_queuedMessages >= kMaxQueuedMessages || g_queuedMessageBytes + message->raw.size() > kMaxQueuedMessageBytes)
        {
            c->out = "HTTP/1.1 503 Service Unavailable\r\n" + Cors(origin) + "Content-Length: 0\r\nConnection: close\r\n\r\n";
            c->closeAfterWrite = true;
            return;
        }
        ++g_queuedMessages;
        g_queuedMessageBytes += message->raw.size();
        g_events.push_back(Event{EV_MESSAGE, p->id, 0, (OVB_CloseReason)0, true, message->raw});
        return JsonReply(c, origin, "{\"ok\":true}");
    }
    if (req.path == "/closing")
    {
        const JsonMember *popupId = FindMember(body, "popupId");
        std::string reason;
        if (!sidOk || !popupId || strtod(popupId->raw.c_str(), NULL) != (double)p->id || popupId->raw[0] == '"') return Deny(c);
        if (!MemberString(body, "reason", &reason) || reason.empty() || Utf8Length(reason) > 64) return Deny(c);
        const JsonMember *exp = FindMember(body, "explicit");
        p->hasNotice = true;
        p->noticeExplicit = exp && exp->raw == "true";
        p->noticeAt = NowMs();
        p->noticeReason = reason;
        return JsonReply(c, origin, "{\"ok\":true}");
    }
    if (req.path == "/open")
    {
        std::string url;
        if (!sidOk || !p->canOpen || !MemberString(body, "url", &url) || url.size() > kMaxUrl) return Deny(c);
        if (p->closeRequested || p->shuttingDown) return Deny(c);   // closing: no new children
        if (LivePopups(p->id, false) >= kMaxChildrenPerPopup || LivePopups(0, true) >= kMaxLivePopups) return Deny(c);
        if (!IsAllowedOrigin(UrlOrigin(url))) return Deny(c);
        int err = 0;
        Popup *child = CreatePopup(url, p->id, p->canOpen, p->connectTimeout, &err);
        if (!child) return Deny(c);
        child->launched = false;
        g_toLaunch.push_back(child->id);
        return JsonReply(c, origin, "{\"popupId\":" + std::to_string(child->id) + "}");
    }
    Deny(c);
}

// Returns false when the request is malformed (connection gets closed)
bool TryParse(Conn *c, Popup *p)
{
    size_t headerEnd = c->in.find("\r\n\r\n");
    if (headerEnd == std::string::npos) return c->in.size() <= kMaxHeader;
    if (headerEnd > kMaxHeader) return false;
    Request req;
    size_t lineEnd = c->in.find("\r\n");
    std::string line = c->in.substr(0, lineEnd);
    size_t sp1 = line.find(' '), sp2 = line.rfind(' ');
    if (sp1 == std::string::npos || sp2 == sp1) return false;
    req.method = line.substr(0, sp1);
    std::string target = line.substr(sp1 + 1, sp2 - sp1 - 1);
    size_t q = target.find('?');
    req.path = target.substr(0, q);
    if (q != std::string::npos) req.query = target.substr(q + 1);
    size_t pos = lineEnd + 2;
    while (pos < headerEnd)
    {
        size_t e = c->in.find("\r\n", pos);
        std::string h = c->in.substr(pos, e - pos);
        pos = e + 2;
        size_t colon = h.find(':');
        if (colon == std::string::npos) continue;
        std::string name = h.substr(0, colon);
        for (char &ch : name) ch = (char)tolower((unsigned char)ch);
        size_t v = h.find_first_not_of(" \t", colon + 1);
        std::string value = v == std::string::npos ? std::string() : h.substr(v);
        while (!value.empty() && (value.back() == ' ' || value.back() == '\t')) value.pop_back();
        if (!req.headers.count(name)) req.headers[name] = value;
    }
    if (req.headers.count("transfer-encoding")) return false;
    size_t length = 0;
    if (req.headers.count("content-length"))
    {
        const std::string &v = req.headers["content-length"];
        if (v.empty() || v.find_first_not_of("0123456789") != std::string::npos || v.size() > 9) return false;
        length = (size_t)strtoul(v.c_str(), NULL, 10);
    }
    if (length > kMaxBody) return false;
    if (c->in.size() < headerEnd + 4 + length) return true;   // wait for the rest of the body
    req.body = c->in.substr(headerEnd + 4, length);
    c->in.clear();
    HandleRequest(c, p, req);
    return true;
}

void CloseConn(Conn *c)
{
    if (c->dead) return;
    c->dead = true;
    closesocket(c->s);
    if (!c->sse) return;
    Popup *p = FindPopup(c->popupId);
    if (p && p->state == OVB_POPUP_OPEN && StreamCount(p->id) == 0)
        p->disconnectedAt = NowMs();
}

// Close detection and connect timeouts (lock held)
void Supervise()
{
    uint64_t now = NowMs();
    for (auto &kv : g_popups)
    {
        Popup *p = kv.second.get();
        if (p->hidden) continue;
        if (p->state == OVB_POPUP_OPEN && p->disconnectedAt && StreamCount(p->id) == 0 && now - p->disconnectedAt >= kGraceMs)
            MarkClosed(p, ResolveReason(p));
        else if (p->state == OVB_POPUP_WAITING && now - p->created >= p->connectTimeout)
            MarkClosed(p, OVB_CLOSE_NEVER_CONNECTED);
    }
    // Closed popups stop serving; a lingering one once its page came and went, or its time is up
    for (auto &kv : g_popups)
    {
        Popup *p = kv.second.get();
        if (p->lingering && (now >= p->lingerUntil || (p->lingerStreamSeen && StreamCount(p->id) == 0)))
            p->lingering = false;
        if ((p->state == OVB_POPUP_CLOSED || p->hidden) && !p->lingering && p->listener != INVALID_SOCKET)
        {
            closesocket(p->listener);
            p->listener = INVALID_SOCKET;
            for (auto &c : g_conns)
                if (c->popupId == p->id) CloseConn(c.get());
        }
    }
    // Popups never reported (overlay failed, child closed before it was shown) are forgotten
    for (auto it = g_popups.begin(); it != g_popups.end();)
    {
        if (it->second->hidden && it->second->listener == INVALID_SOCKET) it = g_popups.erase(it);
        else ++it;
    }
    for (auto &c : g_conns)
    {
        if (c->overflow && !c->dead) CloseConn(c.get());
    }
    for (auto &c : g_conns)
    {
        if (c->dead) continue;
        if (c->sse && c->out.empty() && now - c->lastWrite >= kKeepAliveMs)
        {
            c->out = ": keep-alive\n\n";
            c->lastWrite = now;
        }
        if (!c->sse && now - c->since >= kRequestTimeoutMs) CloseConn(c.get());
    }
    for (size_t i = 0; i < g_conns.size();)
    {
        if (g_conns[i]->dead) g_conns.erase(g_conns.begin() + (ptrdiff_t)i);
        else ++i;
    }
}

void BridgeThread()
{
    std::vector<char> buf(16 * 1024);
    while (!g_stop)
    {
        fd_set readSet, writeSet;
        FD_ZERO(&readSet);
        FD_ZERO(&writeSet);
        u_int count = 0;
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            for (auto &kv : g_popups)
            {
                Popup *p = kv.second.get();
                if (p->listener != INVALID_SOCKET && count < FD_SETSIZE) { FD_SET(p->listener, &readSet); ++count; }
            }
            for (auto &c : g_conns)
            {
                if (c->dead || count >= FD_SETSIZE) continue;
                FD_SET(c->s, &readSet);
                if (!c->out.empty()) FD_SET(c->s, &writeSet);
                ++count;
            }
        }
        if (count == 0)
        {
            Sleep(10);
        }
        else
        {
            timeval tv = {0, 10 * 1000};
            if (select(0, &readSet, &writeSet, NULL, &tv) == SOCKET_ERROR) Sleep(10);
        }

        std::lock_guard<std::mutex> lock(g_mutex);
        // New connections
        for (auto &kv : g_popups)
        {
            Popup *p = kv.second.get();
            if (p->listener == INVALID_SOCKET || !FD_ISSET(p->listener, &readSet)) continue;
            for (;;)
            {
                SOCKET s = accept(p->listener, NULL, NULL);
                if (s == INVALID_SOCKET) break;
                size_t open = 0;
                for (auto &c : g_conns)
                    if (!c->dead && c->popupId == p->id) ++open;
                u_long nonBlocking = 1;
                if (open >= kMaxConnsPerPopup || (p->state == OVB_POPUP_CLOSED && !p->lingering) ||
                    ioctlsocket(s, FIONBIO, &nonBlocking) != 0)
                {
                    closesocket(s);
                    continue;
                }
                std::unique_ptr<Conn> c(new Conn);
                c->s = s;
                c->popupId = p->id;
                c->since = NowMs();
                g_conns.push_back(std::move(c));
            }
        }
        // Reads and writes
        for (size_t i = 0; i < g_conns.size(); ++i)
        {
            Conn *c = g_conns[i].get();
            if (c->dead) continue;
            if (FD_ISSET(c->s, &readSet))
            {
                int n = recv(c->s, buf.data(), (int)buf.size(), 0);
                if (n == 0 || (n == SOCKET_ERROR && WSAGetLastError() != WSAEWOULDBLOCK))
                {
                    CloseConn(c);
                    continue;
                }
                if (n > 0 && !c->sse && !c->closeAfterWrite)
                {
                    c->in.append(buf.data(), (size_t)n);
                    Popup *p = FindPopup(c->popupId);
                    if (!p || c->in.size() > kMaxHeader + kMaxBody + 4 || !TryParse(c, p))
                    {
                        CloseConn(c);
                        continue;
                    }
                }
            }
            if (!c->out.empty())
            {
                int n = send(c->s, c->out.data(), (int)std::min<size_t>(c->out.size(), 64 * 1024), 0);
                if (n == SOCKET_ERROR)
                {
                    if (WSAGetLastError() != WSAEWOULDBLOCK) CloseConn(c);
                    continue;
                }
                c->out.erase(0, (size_t)n);
            }
            if (c->out.empty() && c->closeAfterWrite)
            {
                shutdown(c->s, SD_SEND);
                CloseConn(c);
            }
        }
        Supervise();
    }
    // Stop: close everything
    std::lock_guard<std::mutex> lock(g_mutex);
    for (auto &c : g_conns) CloseConn(c.get());
    g_conns.clear();
    for (auto &kv : g_popups)
        if (kv.second->listener != INVALID_SOCKET) { closesocket(kv.second->listener); kv.second->listener = INVALID_SOCKET; }
}

// The thread keeps this DLL loaded while it runs (reference taken in OVB_Init) and drops the
// reference as it exits. So a FreeLibrary without OVB_Shutdown never unmaps running code, and a
// process that exits without OVB_Shutdown has no C++ thread object left to abort on.
DWORD WINAPI BridgeThreadMain(LPVOID module)
{
    BridgeThread();
    FreeLibraryAndExitThread((HMODULE)module, 0);
}

// Main thread, no lock held
void DispatchEvents()
{
    std::deque<Event> events;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        events.swap(g_events);
        g_queuedMessages = 0;
        g_queuedMessageBytes = 0;
    }
    g_inCallback = true;
    for (const Event &e : events)
    {
        switch (e.type)
        {
        case EV_MESSAGE:
            if (g_config.onMessage) g_config.onMessage(e.id, e.text.c_str(), g_config.user);
            break;
        case EV_CLOSED:
            if (g_config.onClosed) g_config.onClosed(e.id, e.reason, e.hasText ? e.text.c_str() : NULL, g_config.user);
            break;
        case EV_OPENED:
            if (g_config.onOpened) g_config.onOpened(e.id, e.parent, e.text.c_str(), g_config.user);
            break;
        }
    }
    g_inCallback = false;
}

}  // namespace

//-----------------------------------------------------------------------------
// Exports
//-----------------------------------------------------------------------------
extern "C" int OVB_CALL OVB_Init(const OVB_Config *config)
{
    if (!config || config->structSize < sizeof(OVB_Config) || (config->allowedOriginCount && !config->allowedOrigins))
        return OVB_BRIDGE_ERR_ARGS;
    if (g_initialized || g_inCallback) return OVB_BRIDGE_ERR_STATE;
    // Each allowed origin as the browser sends it: "https://Store.example.com/" and
    // "https://store.example.com:443" both become "https://store.example.com". Anything with a
    // path, query, other scheme or a host that is not plain ASCII is an error.
    std::vector<std::string> origins;
    for (uint32_t i = 0; i < config->allowedOriginCount; ++i)
    {
        std::string entry = config->allowedOrigins[i] ? config->allowedOrigins[i] : "";
        size_t rest = 0;
        std::string origin = UrlOrigin(entry, &rest);
        if (origin.empty() || (rest != entry.size() && entry.compare(rest, std::string::npos, "/") != 0))
            return OVB_BRIDGE_ERR_ARGS;
        origins.push_back(origin);
    }
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return OVB_BRIDGE_ERR_NETWORK;
    g_wsa = true;
    g_config = *config;
    g_origins.swap(origins);
    g_config.allowedOrigins = NULL;
    g_stop = false;
    HMODULE self = NULL;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, (LPCWSTR)(void *)&OVB_Init, &self))
    {
        WSACleanup();
        g_wsa = false;
        return OVB_BRIDGE_ERR_STATE;
    }
    g_thread = CreateThread(NULL, 0, BridgeThreadMain, self, 0, NULL);
    if (!g_thread)
    {
        FreeLibrary(self);
        WSACleanup();
        g_wsa = false;
        return OVB_BRIDGE_ERR_STATE;
    }
    g_initialized = true;
    return OVB_BRIDGE_OK;
}

extern "C" void OVB_CALL OVB_Update(void)
{
    if (!g_initialized || g_inCallback || g_shuttingDown) return;
    // Child popups the pages asked for: opened here, on the main thread
    std::deque<uint32_t> toLaunch;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        toLaunch.swap(g_toLaunch);
    }
    for (uint32_t id : toLaunch)
    {
        std::string url;
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            Popup *p = FindPopup(id);
            if (!p || p->state != OVB_POPUP_WAITING) continue;
            url = p->url;
        }
        bool opened = OpenInOverlay(id, url);
        std::lock_guard<std::mutex> lock(g_mutex);
        Popup *p = FindPopup(id);
        if (!p || p->state != OVB_POPUP_WAITING) continue;
        if (!opened)
        {
            MarkClosed(p, OVB_CLOSE_NEVER_CONNECTED);   // not launched: forgotten, never reported
            continue;
        }
        p->launched = true;
        p->created = NowMs();   // the connect timeout counts from the real open
        g_events.push_back(Event{EV_OPENED, p->id, p->parent, (OVB_CloseReason)0, true, p->target});
    }
    DispatchEvents();
}

extern "C" void OVB_CALL OVB_Shutdown(void)
{
    if (!g_initialized || g_inCallback || g_shuttingDown) return;
    g_shuttingDown = true;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_toLaunch.clear();
        for (auto &kv : g_popups)
        {
            Popup *p = kv.second.get();
            if (p->hidden || p->state == OVB_POPUP_CLOSED) continue;
            p->shuttingDown = true;
            RequestClose(p, OVB_CLOSE_SHUTDOWN);
        }
    }
    // Let the pages close themselves (the bridge thread reports them as they go)
    uint64_t end = NowMs() + kShutdownWaitMs;
    for (;;)
    {
        bool open = false;
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            for (auto &kv : g_popups)
                if (!kv.second->hidden && kv.second->state != OVB_POPUP_CLOSED) open = true;
            if (!open || NowMs() >= end)
            {
                for (auto &kv : g_popups)
                    if (!kv.second->hidden) MarkClosed(kv.second.get(), OVB_CLOSE_SHUTDOWN);
                break;
            }
        }
        Sleep(20);
    }
    g_stop = true;
    if (g_thread)
    {
        WaitForSingleObject(g_thread, INFINITE);
        CloseHandle(g_thread);
        g_thread = NULL;
    }
    DispatchEvents();   // the last callbacks; OVB_* calls from them get OVB_BRIDGE_ERR_STATE
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_popups.clear();
        g_events.clear();
        g_queuedMessages = 0;
        g_queuedMessageBytes = 0;
        g_toLaunch.clear();
    }
    g_initialized = false;
    g_shuttingDown = false;
    if (g_wsa) { WSACleanup(); g_wsa = false; }
}

extern "C" int OVB_CALL OVB_OpenUrlEx(const OVB_OpenOptions *options, uint32_t *outPopupId)
{
    if (!options || options->structSize < sizeof(OVB_OpenOptions) || !options->url || !outPopupId) return OVB_BRIDGE_ERR_ARGS;
    if (!g_initialized || g_shuttingDown) return OVB_BRIDGE_ERR_STATE;
    std::string target = options->url;
    if (target.size() > kMaxUrl || UrlOrigin(target).empty()) return OVB_BRIDGE_ERR_ARGS;
    ResolveSteam();   // also refreshes the Steam Deck check
    if (!g_config.openOverlay && (!g_steamFriends || !g_activateWebPage)) return OVB_BRIDGE_ERR_OVERLAY;
    if (!g_config.openOverlay && g_overlayDisabled) return OVB_BRIDGE_ERR_OVERLAY_DISABLED;
    uint32_t id;
    std::string url;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        int err = 0;
        if (LivePopups(0, true) >= kMaxLivePopups) return OVB_BRIDGE_ERR_LIMIT;
        bool canOpen = !(options->flags & OVB_OPEN_NO_CHILD_POPUPS) && !g_onDeck;
        uint64_t timeout = options->connectTimeoutMs ? options->connectTimeoutMs : kDefaultConnectTimeoutMs;
        Popup *p = CreatePopup(target, 0, canOpen, timeout, &err);
        if (!p) return err;
        id = p->id;
        url = p->url;
    }
    if (!OpenInOverlay(id, url))
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        Popup *p = FindPopup(id);
        if (p) { p->hidden = true; p->state = OVB_POPUP_CLOSED; }   // the bridge thread closes its socket
        return OVB_BRIDGE_ERR_OVERLAY;
    }
    *outPopupId = id;
    return OVB_BRIDGE_OK;
}

extern "C" int OVB_CALL OVB_OpenUrl(const char *url, uint32_t *outPopupId)
{
    OVB_OpenOptions options = {};
    options.structSize = sizeof(options);
    options.url = url;
    return OVB_OpenUrlEx(&options, outPopupId);
}

extern "C" int OVB_CALL OVB_PostMessage(uint32_t popupId, const char *json)
{
    if (!json) return OVB_BRIDGE_ERR_ARGS;
    if (!g_initialized || g_shuttingDown) return OVB_BRIDGE_ERR_STATE;
    size_t n = strlen(json);
    if (n > kMaxPostJson || !IsJsonValue(json, n)) return OVB_BRIDGE_ERR_JSON;
    std::lock_guard<std::mutex> lock(g_mutex);
    Popup *p = FindPopup(popupId);
    if (!p) return OVB_BRIDGE_ERR_NOT_FOUND;
    if (p->state == OVB_POPUP_CLOSED) return OVB_BRIDGE_ERR_CLOSED;
    return PushToStreams(popupId, SseEvent("message", std::string(json, n)));
}

extern "C" int OVB_CALL OVB_Close(uint32_t popupId)
{
    if (!g_initialized || g_shuttingDown) return OVB_BRIDGE_ERR_STATE;
    std::lock_guard<std::mutex> lock(g_mutex);
    Popup *p = FindPopup(popupId);
    if (!p) return OVB_BRIDGE_ERR_NOT_FOUND;
    if (p->state == OVB_POPUP_CLOSED) return OVB_BRIDGE_ERR_CLOSED;
    p->closeRequested = true;
    RequestClose(p, OVB_CLOSE_NATIVE_REQUEST);
    return OVB_BRIDGE_OK;
}

extern "C" int OVB_CALL OVB_GetPopupInfo(uint32_t popupId, OVB_PopupInfo *info)
{
    if (!info || info->structSize < sizeof(OVB_PopupInfo)) return OVB_BRIDGE_ERR_ARGS;
    if (!g_initialized || g_shuttingDown) return OVB_BRIDGE_ERR_STATE;
    std::lock_guard<std::mutex> lock(g_mutex);
    Popup *p = FindPopup(popupId);
    if (!p) return OVB_BRIDGE_ERR_NOT_FOUND;
    uint32_t size = info->structSize;
    memset(info, 0, sizeof(OVB_PopupInfo));
    info->structSize = size;
    info->state = (uint32_t)p->state;
    info->closeReason = (uint32_t)p->reason;
    info->parentPopupId = p->parent;
    info->keyUsed = p->keyUsed ? 1 : 0;
    info->streams = (uint32_t)StreamCount(p->id);
    info->canOpenPopup = p->canOpen ? 1 : 0;
    info->hasNotice = p->hasNotice ? 1 : 0;
    info->noticeExplicit = p->noticeExplicit ? 1 : 0;
    info->noticeTimeMs = p->noticeAt;
    strncpy_s(info->noticeReason, sizeof(info->noticeReason), p->noticeReason.c_str(), _TRUNCATE);
    return OVB_BRIDGE_OK;
}
