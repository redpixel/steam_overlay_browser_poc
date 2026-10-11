/*
 * ovb_bridge_loader.h - use the bridge with the DLL and headers only (no import library).
 *
 *   #include "ovb_bridge_loader.h"
 *
 *   OVB_Api ovb;
 *   if (OVB_LoadApi(&ovb, NULL))          // overlay_bridge.dll next to the game's exe
 *       ovb.OVB_Init(&config);            // ... ovb.OVB_Update() every frame, ovb.OVB_Shutdown(), OVB_UnloadApi(&ovb)
 *   else
 *       ;                                 // no DLL: the game runs, the web popup feature is off
 *
 * The DLL is loaded from the executable's folder only (LOAD_LIBRARY_SEARCH_APPLICATION_DIR), never
 * from the current directory or PATH, so a planted DLL elsewhere is not picked up. Its own
 * dependencies (kernel32, ws2_32, bcrypt) come from System32.
 */
#ifndef OVB_BRIDGE_LOADER_H
#define OVB_BRIDGE_LOADER_H

#ifndef OVB_BRIDGE_DYNAMIC
#define OVB_BRIDGE_DYNAMIC
#endif
#include <windows.h>
#include "ovb_bridge.h"

#ifdef __cplusplus
extern "C" {
#endif

#define OVB_BRIDGE_DLL_NAME L"overlay_bridge.dll"

typedef struct OVB_Api {
    HMODULE              module;
    PFN_OVB_Init         OVB_Init;
    PFN_OVB_Update       OVB_Update;
    PFN_OVB_Shutdown     OVB_Shutdown;
    PFN_OVB_OpenUrl      OVB_OpenUrl;
    PFN_OVB_OpenUrlEx    OVB_OpenUrlEx;
    PFN_OVB_PostMessage  OVB_PostMessage;
    PFN_OVB_Close        OVB_Close;
    PFN_OVB_GetPopupInfo OVB_GetPopupInfo;
} OVB_Api;

/* dllName: file name in the executable's folder, or NULL for overlay_bridge.dll.
   Returns nonzero when the DLL and every function were found; otherwise api is zeroed. */
static __inline int OVB_LoadApi(OVB_Api *api, const wchar_t *dllName)
{
    ZeroMemory(api, sizeof(*api));
    api->module = LoadLibraryExW(dllName ? dllName : OVB_BRIDGE_DLL_NAME, NULL,
                                 LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!api->module)
        return 0;
#define OVB_LOAD_FN(name) api->OVB_##name = (PFN_OVB_##name)(void *)GetProcAddress(api->module, "OVB_" #name)
    OVB_LOAD_FN(Init);
    OVB_LOAD_FN(Update);
    OVB_LOAD_FN(Shutdown);
    OVB_LOAD_FN(OpenUrl);
    OVB_LOAD_FN(OpenUrlEx);
    OVB_LOAD_FN(PostMessage);
    OVB_LOAD_FN(Close);
    OVB_LOAD_FN(GetPopupInfo);
#undef OVB_LOAD_FN
    if (!api->OVB_Init || !api->OVB_Update || !api->OVB_Shutdown || !api->OVB_OpenUrl || !api->OVB_OpenUrlEx ||
        !api->OVB_PostMessage || !api->OVB_Close || !api->OVB_GetPopupInfo)
    {
        FreeLibrary(api->module);
        ZeroMemory(api, sizeof(*api));
        return 0;
    }
    return 1;
}

/* Call after api->OVB_Shutdown(). */
static __inline void OVB_UnloadApi(OVB_Api *api)
{
    if (api->module)
        FreeLibrary(api->module);
    ZeroMemory(api, sizeof(*api));
}

#ifdef __cplusplus
}
#endif

#endif /* OVB_BRIDGE_LOADER_H */
