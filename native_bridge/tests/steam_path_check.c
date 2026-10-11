/*
 * steam_path_check.c - TEST ONLY. The bridge DLL's Steam path, against out\fake_steam\steam_api64.dll
 * (fake_steam_api.c) loaded into this process the way a game loads Steam:
 *   - overlay off (IsOverlayEnabled false): OVB_BRIDGE_ERR_OVERLAY_DISABLED, nothing opened
 *   - overlay on: ActivateGameOverlayToWebPage(url + #ovbk=..., Modal)
 *   - Steam Deck: child popups off for the new popup
 *   - SteamUtils not ready yet (NULL, before SteamAPI_Init): the overlay counts as on
 * Exit code 0 = as expected.
 */
#include <stdio.h>
#include <string.h>
#include <windows.h>
#include "../ovb_bridge.h"

typedef void (__cdecl *PfnFakeSet)(int utilsAvailable, int overlayEnabled, int onDeck);
typedef int (__cdecl *PfnFakeActivations)(const char **url, int *mode);

static int g_ok = 1;

static void expect(const char *what, int got, int expected)
{
    printf("%s %s: %d (expect %d)\n", got == expected ? "ok  " : "FAIL", what, got, expected);
    if (got != expected) g_ok = 0;
}

int main(int argc, char **argv)
{
    static const char *origins[] = { "https://store.example.com" };
    char path[MAX_PATH];
    HMODULE steam;
    PfnFakeSet fakeSet;
    PfnFakeActivations fakeActivations;
    OVB_Config config;
    OVB_PopupInfo info;
    uint32_t popupId = 0;
    const char *url = NULL;
    int mode = 0, calls;

    /* out\fake_steam\steam_api64.dll next to this exe's folder */
    GetModuleFileNameA(NULL, path, MAX_PATH);
    strrchr(path, '\\')[1] = '\0';
    strcat_s(path, sizeof(path), "fake_steam\\steam_api64.dll");
    steam = LoadLibraryA(argc > 1 ? argv[1] : path);
    if (!steam) { printf("FAIL cannot load %s\n", path); return 1; }
    fakeSet = (PfnFakeSet)(void *)GetProcAddress(steam, "fake_set");
    fakeActivations = (PfnFakeActivations)(void *)GetProcAddress(steam, "fake_activations");

    ZeroMemory(&config, sizeof(config));
    config.structSize = sizeof(config);
    config.allowedOrigins = origins;
    config.allowedOriginCount = 1;
    expect("OVB_Init", OVB_Init(&config), OVB_BRIDGE_OK);

    fakeSet(1, 0, 0);
    expect("overlay off: OVB_OpenUrl", OVB_OpenUrl("https://store.example.com/event", &popupId), OVB_BRIDGE_ERR_OVERLAY_DISABLED);
    expect("overlay off: nothing opened", fakeActivations(&url, &mode), 0);

    fakeSet(1, 1, 0);
    expect("overlay on: OVB_OpenUrl", OVB_OpenUrl("https://store.example.com/event", &popupId), OVB_BRIDGE_OK);
    calls = fakeActivations(&url, &mode);
    expect("overlay on: opened once", calls, 1);
    expect("overlay on: Modal", mode, 1);
    expect("overlay on: URL with the launch token",
           strncmp(url, "https://store.example.com/event#ovbk=", strlen("https://store.example.com/event#ovbk=")) == 0, 1);
    ZeroMemory(&info, sizeof(info));
    info.structSize = sizeof(info);
    OVB_GetPopupInfo(popupId, &info);
    expect("desktop: child popups allowed", (int)info.canOpenPopup, 1);

    fakeSet(1, 1, 1);
    expect("Steam Deck: OVB_OpenUrl", OVB_OpenUrl("https://store.example.com/event", &popupId), OVB_BRIDGE_OK);
    OVB_GetPopupInfo(popupId, &info);
    expect("Steam Deck: child popups off", (int)info.canOpenPopup, 0);

    fakeSet(0, 0, 0);
    expect("SteamUtils not ready: OVB_OpenUrl", OVB_OpenUrl("https://store.example.com/event", &popupId), OVB_BRIDGE_OK);

    OVB_Shutdown();
    printf("RESULT: %s\n", g_ok ? "OK" : "FAILED");
    return g_ok ? 0 : 1;
}
