/*
 * ovb_token.c - launch token for the OverlayBridge overlay bridge (PoC). See ovb_token.h.
 */
#include "ovb_token.h"

#include <string.h>

/* Windows only for now (Windows SDK: bcrypt). macOS / Linux will be added later. */
#ifndef _WIN32
#error "ovb_token.c currently builds on Windows only"
#endif
#include <windows.h>
#include <bcrypt.h>
#pragma comment(lib, "bcrypt.lib")

#define OVB_RAW_BYTES (1 + 2 + OVB_KEY_BYTES)   /* 35 */

int ovb_random(uint8_t *buf, size_t len)
{
    if (!buf || len > 0xFFFFFFFFu)
        return OVB_ERR_ARGS;
    return BCRYPT_SUCCESS(BCryptGenRandom(NULL, buf, (ULONG)len, BCRYPT_USE_SYSTEM_PREFERRED_RNG)) ? OVB_OK : OVB_ERR_RANDOM;
}

size_t ovb_base64url(const uint8_t *in, size_t len, char *out)
{
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    size_t i, o = 0;
    for (i = 0; i + 2 < len; i += 3)
    {
        uint32_t v = ((uint32_t)in[i] << 16) | ((uint32_t)in[i + 1] << 8) | in[i + 2];
        out[o++] = alphabet[(v >> 18) & 63];
        out[o++] = alphabet[(v >> 12) & 63];
        out[o++] = alphabet[(v >> 6) & 63];
        out[o++] = alphabet[v & 63];
    }
    if (len - i == 1)
    {
        uint32_t v = (uint32_t)in[i] << 16;
        out[o++] = alphabet[(v >> 18) & 63];
        out[o++] = alphabet[(v >> 12) & 63];
    }
    else if (len - i == 2)
    {
        uint32_t v = ((uint32_t)in[i] << 16) | ((uint32_t)in[i + 1] << 8);
        out[o++] = alphabet[(v >> 18) & 63];
        out[o++] = alphabet[(v >> 12) & 63];
        out[o++] = alphabet[(v >> 6) & 63];
    }
    out[o] = '\0';
    return o;
}

int ovb_encode_token(uint16_t port, const uint8_t key[OVB_KEY_BYTES], char *out, size_t outSize)
{
    uint8_t raw[OVB_RAW_BYTES];

    if (!key || !out || port == 0)
        return OVB_ERR_ARGS;
    if (outSize < OVB_TOKEN_CHARS + 1)
        return OVB_ERR_BUFFER;

    raw[0] = OVB_TOKEN_VERSION;
    raw[1] = (uint8_t)(port >> 8);
    raw[2] = (uint8_t)(port & 0xFF);
    memcpy(raw + 3, key, OVB_KEY_BYTES);

    ovb_base64url(raw, OVB_RAW_BYTES, out);
    SecureZeroMemory(raw, sizeof(raw));
    return OVB_OK;
}

int ovb_build_popup_url(const char *url, uint16_t port, const uint8_t key[OVB_KEY_BYTES], char *out, size_t outSize)
{
    char token[OVB_TOKEN_CHARS + 1];
    size_t urlLen, need;
    int rc;

    if (!url || !key || !out)
        return OVB_ERR_ARGS;
    rc = ovb_encode_token(port, key, token, sizeof(token));
    if (rc != OVB_OK)
        return rc;

    urlLen = strlen(url);
    need = urlLen + 1 + (sizeof(OVB_FRAGMENT_PARAM "=") - 1) + OVB_TOKEN_CHARS + 1;
    if (outSize < need)
    {
        SecureZeroMemory(token, sizeof(token));
        return OVB_ERR_BUFFER;
    }

    memcpy(out, url, urlLen);
    out[urlLen] = strchr(url, '#') ? '&' : '#';
    memcpy(out + urlLen + 1, OVB_FRAGMENT_PARAM "=", sizeof(OVB_FRAGMENT_PARAM "=") - 1);
    memcpy(out + urlLen + sizeof(OVB_FRAGMENT_PARAM "="), token, OVB_TOKEN_CHARS + 1);
    SecureZeroMemory(token, sizeof(token));
    return OVB_OK;
}
