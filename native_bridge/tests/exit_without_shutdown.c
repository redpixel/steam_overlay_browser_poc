/*
 * exit_without_shutdown.c - TEST ONLY. A game that never calls OVB_Shutdown must still exit
 * cleanly (no abort from the DLL's bridge thread).
 *   exit_without_shutdown.exe exit     OVB_Init, a few OVB_Update, then return from main
 *   exit_without_shutdown.exe unload   same, then OVB_UnloadApi (FreeLibrary) and keep running a while
 * Exit code 0 = as expected. Needs overlay_bridge.dll next to the exe.
 */
#include <stdio.h>
#include <string.h>
#include "../ovb_bridge_loader.h"

static int OVB_CALL OpenOverlay(uint32_t popupId, const char *url, void *user)
{
    (void)popupId; (void)url; (void)user;
    return 1;   /* no Steam: pretend it was shown */
}

int main(int argc, char **argv)
{
    static const char *origins[] = { "https://store.example.com" };
    OVB_Api ovb;
    OVB_Config config;
    uint32_t popupId = 0;
    int frame;
    int unload = argc > 1 && strcmp(argv[1], "unload") == 0;

    if (!OVB_LoadApi(&ovb, NULL))
    {
        printf("overlay_bridge.dll not found\n");
        return 2;
    }
    ZeroMemory(&config, sizeof(config));
    config.structSize = sizeof(config);
    config.allowedOrigins = origins;
    config.allowedOriginCount = 1;
    config.openOverlay = OpenOverlay;
    if (ovb.OVB_Init(&config) != OVB_BRIDGE_OK || ovb.OVB_OpenUrl("https://store.example.com/event", &popupId) != OVB_BRIDGE_OK)
    {
        printf("init/open failed\n");
        return 3;
    }
    for (frame = 0; frame < 10; ++frame)
    {
        ovb.OVB_Update();
        Sleep(16);
    }
    if (unload)
    {
        OVB_UnloadApi(&ovb);   /* no OVB_Shutdown: the bridge thread keeps the DLL loaded */
        for (frame = 0; frame < 30; ++frame)
            Sleep(16);
        printf("FreeLibrary without OVB_Shutdown: still running\n");
    }
    printf("RESULT: OK (%s without OVB_Shutdown)\n", unload ? "unload + exit" : "exit");
    return 0;
}
