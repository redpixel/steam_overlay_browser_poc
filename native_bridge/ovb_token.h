/*
 * ovb_token.h - launch token for the OverlayBridge overlay bridge (PoC)
 *
 * The game passes the bridge port and one-time key to the popup page as ONE fragment
 * parameter:  <url>#ovbk=<token>  (or  <url>#<page hash>&ovbk=<token>).
 * The fragment never reaches the web server; overlay-bridge.js decodes and strips it.
 *
 * Token = base64url( version(0x01) port(uint16 big-endian) key[32] ), no padding, 47 chars.
 * Not encrypted on purpose: any decryption key would have to ship inside overlay-bridge.js.
 * Security comes from the one-time key, the fragment (never sent to the web server),
 * the Origin/Host checks and the loopback-only bridge server.
 *
 * Builds with the Windows SDK only (no third-party libraries). macOS / Linux: later.
 */
#ifndef OVB_TOKEN_H
#define OVB_TOKEN_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32) && defined(OVB_BUILD_DLL)
#define OVB_API __declspec(dllexport)
#else
#define OVB_API
#endif

#define OVB_KEY_BYTES        32
#define OVB_TOKEN_VERSION    0x01
#define OVB_TOKEN_CHARS      47                     /* without the terminating NUL */
#define OVB_FRAGMENT_PARAM   "ovbk"

enum
{
    OVB_OK = 0,
    OVB_ERR_ARGS = -1,
    OVB_ERR_BUFFER = -2,    /* output buffer too small */
    OVB_ERR_RANDOM = -3,
};

/* base64url without padding. out needs (len + 2) / 3 * 4 + 1 chars. Returns the chars written (NUL not counted). */
OVB_API size_t ovb_base64url(const uint8_t *in, size_t len, char *out);

/* Fills buf with cryptographically secure random bytes (BCryptGenRandom). Use it for the one-time key. */
OVB_API int ovb_random(uint8_t *buf, size_t len);

/* Writes the 47-char token + NUL to out (outSize >= OVB_TOKEN_CHARS + 1). port must not be 0. */
OVB_API int ovb_encode_token(uint16_t port, const uint8_t key[OVB_KEY_BYTES], char *out, size_t outSize);

/*
 * Appends the token to url as a fragment parameter:
 *   no '#' in url  ->  url#ovbk=<token>
 *   url has '#'    ->  url&ovbk=<token>   (the page's own fragment is kept as is)
 */
OVB_API int ovb_build_popup_url(const char *url, uint16_t port, const uint8_t key[OVB_KEY_BYTES],
                                char *out, size_t outSize);

#ifdef __cplusplus
}
#endif

#endif /* OVB_TOKEN_H */
