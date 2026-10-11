/*
 * ovb_bridge.h - OverlayBridge overlay bridge (PoC): web popups in the Steam overlay that talk to the game.
 *
 * The game opens a popup with OVB_OpenUrl(). The DLL opens a small HTTP server on 127.0.0.1
 * for that popup, appends the launch token (#ovbk=...) to the URL and opens it in the Steam
 * overlay. The page's overlay-bridge.js connects back: web -> native messages, native -> web
 * messages, close from the game, and close detection with a reason.
 *
 * Threads:
 *   - Call every function from the game's main thread.
 *   - Call OVB_Update() once per frame. Child popups the page asked for are opened there
 *     (ActivateGameOverlayToWebPage must run on the main thread) and every callback runs there.
 *     Servers, connections and close detection run on an internal bridge thread and keep
 *     going between OVB_Update() calls; only the callbacks wait for the next OVB_Update().
 *   - The DLL creates no window and installs no hook.
 *
 * Steam: steam_api64.dll is not linked. The DLL looks it up in the game process
 * (GetModuleHandle) and calls the flat API. Steamworks callbacks are not used.
 *
 * Windows SDK only. The C/C++ runtime is linked statically (no VC++ Redistributable).
 */
#ifndef OVB_BRIDGE_H
#define OVB_BRIDGE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifdef OVB_BRIDGE_BUILD
#define OVB_BRIDGE_API __declspec(dllexport)
#else
#define OVB_BRIDGE_API __declspec(dllimport)
#endif
#define OVB_CALL __cdecl

/* Return codes (negative = error) */
#define OVB_BRIDGE_OK                0
#define OVB_BRIDGE_ERR_ARGS         (-1)
#define OVB_BRIDGE_ERR_STATE        (-2)    /* not initialized, already initialized, OVB_Init from a callback, or during OVB_Shutdown */
#define OVB_BRIDGE_ERR_NETWORK      (-3)    /* could not open the local server */
#define OVB_BRIDGE_ERR_OVERLAY      (-4)    /* no Steam (steam_api64.dll not loaded) and no openOverlay callback, or it failed */
#define OVB_BRIDGE_ERR_NOT_FOUND    (-5)    /* unknown popup id */
#define OVB_BRIDGE_ERR_CLOSED       (-6)    /* the popup is already closed */
#define OVB_BRIDGE_ERR_JSON         (-7)    /* not valid JSON, or too large */
#define OVB_BRIDGE_ERR_RANDOM       (-8)    /* the OS random generator failed */
#define OVB_BRIDGE_ERR_LIMIT        (-9)    /* too many open popups (64) */
#define OVB_BRIDGE_ERR_OVERLAY_DISABLED (-10) /* the Steam overlay is off (SteamUtils()->IsOverlayEnabled() is false):
                                                ask the user to turn it on. Right after the game starts it is false for a
                                                few seconds while the overlay loads, so trying again later can succeed */

typedef enum OVB_CloseReason {
    OVB_CLOSE_NATIVE_REQUEST  = 1,   /* the game closed it (OVB_Close), or its parent closed */
    OVB_CLOSE_PAGE_REQUEST    = 2,   /* the page closed itself (window.close(), OverlayBridge.closePopup) */
    OVB_CLOSE_CONNECTION_LOST = 3,   /* the connection dropped with no notice (crash, a user close whose notice was lost) */
    OVB_CLOSE_NEVER_CONNECTED = 4,   /* the page did not connect in time */
    OVB_CLOSE_SHUTDOWN        = 5,   /* OVB_Shutdown */
    OVB_CLOSE_USER_CLOSED     = 6    /* the user closed it (overlay X, Steam Deck B / Steam button). Best effort:
                                        treat CONNECTION_LOST the same way */
} OVB_CloseReason;

/* Web -> native. json is the page's message as JSON text, unchanged. Valid during the call only.
   Messages wait for OVB_Update(); while 1024 messages or 8 MB are waiting, more are refused (the
   page's postMessage() resolves false). */
typedef void (OVB_CALL *OVB_OnMessage)(uint32_t popupId, const char *json, void *user);
/* The popup closed. pageReason: the page's last close notice ("window.close", "purchase-done",
   "hidden", ...) or NULL. Called once for every popup the game knows: one OVB_OpenUrl returned, or a
   child reported by onOpened. A child that closes before it was shown is never reported. */
typedef void (OVB_CALL *OVB_OnClosed)(uint32_t popupId, OVB_CloseReason reason, const char *pageReason, void *user);
/* The page opened a child popup (target="_blank", window.open, OverlayBridge.openPopup). Already
   shown in the overlay when this is called. url is the page's URL without the launch token. */
typedef void (OVB_CALL *OVB_OnOpened)(uint32_t popupId, uint32_t parentPopupId, const char *url, void *user);
/* Optional: shows url in place of the Steam overlay (tests, other platforms). Return nonzero on success. */
typedef int (OVB_CALL *OVB_OpenOverlay)(uint32_t popupId, const char *url, void *user);

typedef struct OVB_Config {
    uint32_t            structSize;          /* sizeof(OVB_Config) */
    const char *const  *allowedOrigins;      /* origins allowed to connect, e.g. "https://store.example.com".
                                                Case, a trailing '/' and a default port are normalized; a path,
                                                another scheme or a non-ASCII host (use punycode) is OVB_BRIDGE_ERR_ARGS */
    uint32_t            allowedOriginCount;
    OVB_OnMessage       onMessage;           /* may be NULL */
    OVB_OnClosed        onClosed;            /* may be NULL */
    OVB_OnOpened        onOpened;            /* may be NULL */
    OVB_OpenOverlay     openOverlay;         /* NULL = Steam overlay (ActivateGameOverlayToWebPage, Modal) */
    void               *user;                /* passed to every callback */
} OVB_Config;

/* OVB_OpenOptions.flags */
#define OVB_OPEN_NO_CHILD_POPUPS  0x1u       /* the page (and its children) cannot open more popups.
                                                Always on for the Steam Deck: its overlay shows one page at a time */

typedef struct OVB_OpenOptions {
    uint32_t    structSize;                  /* sizeof(OVB_OpenOptions) */
    const char *url;                         /* http(s) URL; the page's own #fragment is kept */
    uint32_t    flags;
    uint32_t    connectTimeoutMs;            /* 0 = 300000. NEVER_CONNECTED if the page does not connect in time */
} OVB_OpenOptions;

typedef enum OVB_PopupState {
    OVB_POPUP_WAITING = 1,                   /* opened, page not connected yet */
    OVB_POPUP_OPEN    = 2,
    OVB_POPUP_CLOSED  = 3
} OVB_PopupState;

/* Diagnostics */
typedef struct OVB_PopupInfo {
    uint32_t structSize;                     /* sizeof(OVB_PopupInfo), set by the caller */
    uint32_t state;                          /* OVB_PopupState */
    uint32_t closeReason;                    /* OVB_CloseReason once closed, else 0 */
    uint32_t parentPopupId;                  /* 0 = opened by the game */
    uint32_t keyUsed;                        /* the page exchanged its one-time key */
    uint32_t streams;                        /* live event streams (connected pages) */
    uint32_t canOpenPopup;
    uint32_t hasNotice;                      /* the page sent a close notice (below) since it last connected */
    uint32_t noticeExplicit;
    uint64_t noticeTimeMs;                   /* GetTickCount64() when it arrived */
    char     noticeReason[260];              /* UTF-8, at most 64 characters */
} OVB_PopupInfo;

/* Function pointer types, for loading the DLL at run time (ovb_bridge_loader.h) */
typedef int  (OVB_CALL *PFN_OVB_Init)(const OVB_Config *config);
typedef void (OVB_CALL *PFN_OVB_Update)(void);
typedef void (OVB_CALL *PFN_OVB_Shutdown)(void);
typedef int  (OVB_CALL *PFN_OVB_OpenUrl)(const char *url, uint32_t *outPopupId);
typedef int  (OVB_CALL *PFN_OVB_OpenUrlEx)(const OVB_OpenOptions *options, uint32_t *outPopupId);
typedef int  (OVB_CALL *PFN_OVB_PostMessage)(uint32_t popupId, const char *json);
typedef int  (OVB_CALL *PFN_OVB_Close)(uint32_t popupId);
typedef int  (OVB_CALL *PFN_OVB_GetPopupInfo)(uint32_t popupId, OVB_PopupInfo *info);

/* Define OVB_BRIDGE_DYNAMIC to use only the DLL + headers (no .lib): see ovb_bridge_loader.h */
#ifndef OVB_BRIDGE_DYNAMIC
OVB_BRIDGE_API int  OVB_CALL OVB_Init(const OVB_Config *config);
OVB_BRIDGE_API void OVB_CALL OVB_Update(void);
/* Closes every popup (SHUTDOWN), waits up to 3 s for the pages to close, runs the remaining
   callbacks and stops the bridge thread. Ignored from inside a callback. A game that exits without
   it does not crash, but the bridge thread keeps the DLL loaded until the process ends. */
OVB_BRIDGE_API void OVB_CALL OVB_Shutdown(void);

OVB_BRIDGE_API int  OVB_CALL OVB_OpenUrl(const char *url, uint32_t *outPopupId);
OVB_BRIDGE_API int  OVB_CALL OVB_OpenUrlEx(const OVB_OpenOptions *options, uint32_t *outPopupId);
/* Native -> web. json must be valid JSON. Returns the number of connected pages it went to (0 = not
   connected yet, dropped), or an error. */
OVB_BRIDGE_API int  OVB_CALL OVB_PostMessage(uint32_t popupId, const char *json);
/* Asks the page to close itself (NATIVE_REQUEST). Its children close too. A popup whose page has
   not connected yet (still loading) is reported closed at once; its server stays up to 60 s more and
   tells the page to close as soon as it connects, so the page does not stay on screen. */
OVB_BRIDGE_API int  OVB_CALL OVB_Close(uint32_t popupId);
OVB_BRIDGE_API int  OVB_CALL OVB_GetPopupInfo(uint32_t popupId, OVB_PopupInfo *info);
#endif

#ifdef __cplusplus
}
#endif

#endif /* OVB_BRIDGE_H */
