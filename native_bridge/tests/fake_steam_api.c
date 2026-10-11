/*
 * fake_steam_api.c - TEST ONLY. Built as out\fake_steam\steam_api64.dll: the few flat Steam API
 * functions the bridge DLL looks up, with answers the test sets (fake_set). No Steam involved.
 */
#include <string.h>

#define FAKE_API __declspec(dllexport)

static int g_utilsAvailable = 1;   /* 0: SteamUtils accessor returns NULL (before SteamAPI_Init) */
static int g_overlayEnabled = 1;
static int g_onDeck = 0;
static int g_activateCalls = 0;
static int g_lastMode = -1;
static char g_lastUrl[4096];
static int g_friends, g_utils;     /* their addresses stand for the interface objects */

FAKE_API void __cdecl fake_set(int utilsAvailable, int overlayEnabled, int onDeck)
{
    g_utilsAvailable = utilsAvailable;
    g_overlayEnabled = overlayEnabled;
    g_onDeck = onDeck;
}

/* Number of ActivateGameOverlayToWebPage calls so far; the last URL and mode */
FAKE_API int __cdecl fake_activations(const char **url, int *mode)
{
    *url = g_lastUrl;
    *mode = g_lastMode;
    return g_activateCalls;
}

FAKE_API void *__cdecl SteamAPI_SteamFriends_v018(void) { return &g_friends; }

FAKE_API void __cdecl SteamAPI_ISteamFriends_ActivateGameOverlayToWebPage(void *self, const char *url, int mode)
{
    if (self != &g_friends) return;
    ++g_activateCalls;
    g_lastMode = mode;
    strncpy_s(g_lastUrl, sizeof(g_lastUrl), url, _TRUNCATE);
}

FAKE_API void *__cdecl SteamAPI_SteamUtils_v010(void) { return g_utilsAvailable ? &g_utils : NULL; }

FAKE_API int __cdecl SteamAPI_ISteamUtils_IsSteamRunningOnSteamDeck(void *self) { return self == &g_utils && g_onDeck; }

FAKE_API int __cdecl SteamAPI_ISteamUtils_IsOverlayEnabled(void *self) { return self == &g_utils && g_overlayEnabled; }
