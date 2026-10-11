/*
 * Prints ovb_token outputs for fixed inputs as JSON, so tests/unit/token.test.mjs can check them
 * against an independent encoder (Node's Buffer) and against the decoder in overlay-bridge.js.
 * Also self-checks error handling (exit code != 0 on failure).
 */
#include "../ovb_token.h"

#include <stdio.h>
#include <string.h>

static int g_failures = 0;
#define CHECK(cond) do { if (!(cond)) { fprintf(stderr, "CHECK failed: %s (line %d)\n", #cond, __LINE__); g_failures++; } } while (0)

static void print_hex(const uint8_t *p, size_t n)
{
    size_t i;
    for (i = 0; i < n; i++)
        printf("%02x", p[i]);
}

static void seq(uint8_t *p, size_t n, uint8_t start)
{
    size_t i;
    for (i = 0; i < n; i++)
        p[i] = (uint8_t)(start + i);
}

int main(void)
{
    static const char *urls[] = {
        "https://event.example.com/page",
        "https://event.example.com/page?tab=2",
        "https://event.example.com/page#/event",
        "https://event.example.com/page#/event?tab=2",
        "https://event.example.com/page#section-3",
        "https://event.example.com/app/?q=a%20b#/list/7?sort=desc&page=2",
        "https://event.example.com/page#",
    };
    static const uint16_t ports[] = { 1, 80, 27080, 51069, 65535 };
    uint8_t key[OVB_KEY_BYTES];
    char token[OVB_TOKEN_CHARS + 1], url[512];
    size_t i;

    printf("{\n");

    /* 1. tokens for fixed port/key */
    printf("\"tokens\":[");
    for (i = 0; i < sizeof(ports) / sizeof(ports[0]); i++)
    {
        seq(key, sizeof(key), (uint8_t)(0xA0 + i * 7));
        CHECK(ovb_encode_token(ports[i], key, token, sizeof(token)) == OVB_OK);
        CHECK(strlen(token) == OVB_TOKEN_CHARS);
        printf("%s{\"port\":%u,\"key\":\"", i ? "," : "", ports[i]);
        print_hex(key, sizeof(key));
        printf("\",\"token\":\"%s\"}", token);
    }
    printf("],\n");

    /* 2. popup URLs */
    printf("\"urls\":[");
    seq(key, sizeof(key), 0x33);
    for (i = 0; i < sizeof(urls) / sizeof(urls[0]); i++)
    {
        CHECK(ovb_build_popup_url(urls[i], 51069, key, url, sizeof(url)) == OVB_OK);
        printf("%s{\"in\":\"%s\",\"out\":\"%s\"}", i ? "," : "", urls[i], url);
    }
    printf("],\n");

    /* 3. error handling */
    CHECK(ovb_encode_token(1, key, token, OVB_TOKEN_CHARS) == OVB_ERR_BUFFER);
    CHECK(ovb_encode_token(0, key, token, sizeof(token)) == OVB_ERR_ARGS);          /* port 0 */
    CHECK(ovb_encode_token(1, NULL, token, sizeof(token)) == OVB_ERR_ARGS);
    CHECK(ovb_build_popup_url("https://a.b/", 1, key, url, 20) == OVB_ERR_BUFFER);
    CHECK(ovb_build_popup_url(NULL, 1, key, url, sizeof(url)) == OVB_ERR_ARGS);
    {
        /* exact fit: url + '#' + "ovbk=" + 47 + NUL */
        const char *u = "https://a.b/";
        size_t exact = strlen(u) + 1 + (sizeof(OVB_FRAGMENT_PARAM "=") - 1) + OVB_TOKEN_CHARS + 1;
        CHECK(ovb_build_popup_url(u, 1, key, url, exact) == OVB_OK);
        CHECK(ovb_build_popup_url(u, 1, key, url, exact - 1) == OVB_ERR_BUFFER);
    }
    {
        /* ovb_random: fills and differs between calls */
        uint8_t a[OVB_KEY_BYTES], b[OVB_KEY_BYTES];
        CHECK(ovb_random(a, sizeof(a)) == OVB_OK);
        CHECK(ovb_random(b, sizeof(b)) == OVB_OK);
        CHECK(memcmp(a, b, sizeof(a)) != 0);
        CHECK(ovb_random(NULL, 1) == OVB_ERR_ARGS);
    }

    printf("\"selfCheckFailures\":%d\n}\n", g_failures);
    return g_failures ? 1 : 0;
}
