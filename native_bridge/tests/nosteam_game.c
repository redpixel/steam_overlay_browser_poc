/*
 * nosteam_game.c - TEST ONLY. A "game" that links the bridge DLL but not Steam, to check that it
 * starts and runs without steam_api64.dll and that only the overlay feature is off.
 * Exit code 0 = as expected.
 */
#include <stdio.h>
#include <windows.h>
#include "../ovb_bridge.h"

int main(void)
{
    static const char *origins[] = { "https://store.example.com" };
    OVB_Config config;
    uint32_t popupId = 0;
    int rc, frame, ok = 1;

    printf("steam_api64.dll in process before init: %s\n", GetModuleHandleW(L"steam_api64.dll") ? "yes" : "no");

    ZeroMemory(&config, sizeof(config));
    config.structSize = sizeof(config);
    config.allowedOrigins = origins;
    config.allowedOriginCount = 1;
    rc = OVB_Init(&config);
    printf("OVB_Init -> %d (expect 0)\n", rc);
    ok &= rc == OVB_BRIDGE_OK;

    rc = OVB_OpenUrl("https://store.example.com/event", &popupId);
    printf("OVB_OpenUrl -> %d (expect %d: no Steam overlay)\n", rc, OVB_BRIDGE_ERR_OVERLAY);
    ok &= rc == OVB_BRIDGE_ERR_OVERLAY;

    rc = OVB_PostMessage(1, "{\"cmd\":\"x\"}");
    printf("OVB_PostMessage(unknown popup) -> %d (expect %d)\n", rc, OVB_BRIDGE_ERR_NOT_FOUND);
    ok &= rc == OVB_BRIDGE_ERR_NOT_FOUND;

    for (frame = 0; frame < 120; ++frame)   /* about 2 seconds of game frames */
    {
        OVB_Update();
        Sleep(16);
    }
    printf("ran %d frames with OVB_Update\n", frame);

    OVB_Shutdown();
    printf("OVB_Shutdown done\n");
    printf("steam_api64.dll in process at exit: %s\n", GetModuleHandleW(L"steam_api64.dll") ? "yes" : "no");
    ok &= GetModuleHandleW(L"steam_api64.dll") == NULL;

    printf(ok ? "RESULT: OK (game ran, overlay feature off)\n" : "RESULT: UNEXPECTED\n");
    return ok ? 0 : 1;
}
