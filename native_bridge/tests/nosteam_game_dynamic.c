/*
 * nosteam_game_dynamic.c - TEST ONLY. Like nosteam_game.c, but uses the bridge through
 * ovb_bridge_loader.h: built without the import library, it runs with or without the DLL.
 * Exit code 0 = as expected (DLL found: overlay feature off without Steam; no DLL: feature off).
 */
#include <stdio.h>
#include "../ovb_bridge_loader.h"

int main(void)
{
    static const char *origins[] = { "https://store.example.com" };
    OVB_Api ovb;
    OVB_Config config;
    uint32_t popupId = 0;
    int rc, frame, ok = 1;

    if (!OVB_LoadApi(&ovb, NULL))
    {
        printf("overlay_bridge.dll not found: web popup feature off, game keeps running\n");
        for (frame = 0; frame < 60; ++frame)
            Sleep(16);
        printf("ran %d frames\nRESULT: OK (no DLL)\n", frame);
        return 0;
    }
    printf("overlay_bridge.dll loaded\n");

    ZeroMemory(&config, sizeof(config));
    config.structSize = sizeof(config);
    config.allowedOrigins = origins;
    config.allowedOriginCount = 1;
    rc = ovb.OVB_Init(&config);
    printf("OVB_Init -> %d (expect 0)\n", rc);
    ok &= rc == OVB_BRIDGE_OK;

    rc = ovb.OVB_OpenUrl("https://store.example.com/event", &popupId);
    printf("OVB_OpenUrl -> %d (expect %d: no Steam overlay)\n", rc, OVB_BRIDGE_ERR_OVERLAY);
    ok &= rc == OVB_BRIDGE_ERR_OVERLAY;

    for (frame = 0; frame < 60; ++frame)
    {
        ovb.OVB_Update();
        Sleep(16);
    }
    ovb.OVB_Shutdown();
    OVB_UnloadApi(&ovb);
    printf("ran %d frames, shut down, DLL unloaded\n", frame);
    printf("steam_api64.dll in process at exit: %s\n", GetModuleHandleW(L"steam_api64.dll") ? "yes" : "no");
    ok &= GetModuleHandleW(L"steam_api64.dll") == NULL;

    printf(ok ? "RESULT: OK (DLL + headers only, overlay feature off)\n" : "RESULT: UNEXPECTED\n");
    return ok ? 0 : 1;
}
